import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ToolCallInfo, ToolEndInfo } from "./types.js";
import * as logger from "./logger.js";

export interface BridgeOptions {
    cwd: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    spawnFn?: typeof spawn;
}

export interface ImageContent {
    type: "image";
    data: string;
    mimeType: string;
}

export interface SendOptions {
    onToolStart?: (info: ToolCallInfo) => void;
    onToolEnd?: (info: ToolEndInfo) => void;
    onText?: (text: string) => void;
    images?: ImageContent[];
}

interface Pending {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    onToolStart?: (info: ToolCallInfo) => void;
    onToolEnd?: (info: ToolEndInfo) => void;
    onText?: (text: string) => void;
}

export class Bridge extends EventEmitter {
    private proc: ChildProcess | null = null;
    private buffer = "";
    private responseText = "";
    private responseQueue: Pending[] = [];
    private rpcPending = new Map<string, Pending>();
    private opts: BridgeOptions;

    constructor(opts: BridgeOptions) {
        super();
        this.opts = opts;
    }

    start(): void {
        const cmd = this.opts.command ?? "pi";
        const args = this.opts.args ?? ["--mode", "rpc", "--continue"];
        const doSpawn = this.opts.spawnFn ?? spawn;

        this.proc = doSpawn(cmd, args, {
            cwd: this.opts.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: this.opts.env
                ? { ...process.env, ...this.opts.env }
                : process.env,
        });

        this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
        this.proc.stderr!.on("data", (chunk: Buffer) => {
            logger.error("Pi stderr output", { output: chunk.toString().trim() });
        });
        this.proc.on("exit", (code, signal) => {
            this.rejectAll(new Error(`Pi exited (code=${code}, signal=${signal})`));
            this.emit("exit", code, signal);
        });
        this.proc.on("error", (err) => {
            this.rejectAll(err);
            this.emit("error", err);
        });
    }

    sendMessage(text: string, options?: SendOptions): Promise<string> {
        if (!this.proc?.stdin?.writable) {
            return Promise.reject(new Error("Pi process not running"));
        }
        return new Promise((resolve, reject) => {
            const entry: Pending = {
                resolve, reject,
                onToolStart: options?.onToolStart,
                onToolEnd: options?.onToolEnd,
                onText: options?.onText,
            };
            this.responseQueue.push(entry);
            // Use prompt with followUp streaming behavior:
            // - if pi is idle: starts processing immediately
            // - if pi is busy: queues for after current turn
            const rpcParams: Record<string, unknown> = {
                message: text,
                streamingBehavior: "followUp",
            };
            if (options?.images && options.images.length > 0) {
                rpcParams.images = options.images;
            }
            this.rpc("prompt", rpcParams).catch((err) => {
                const idx = this.responseQueue.indexOf(entry);
                if (idx >= 0) this.responseQueue.splice(idx, 1);
                reject(err);
            });
        });
    }

    async restart(): Promise<void> {
        // Remove exit/error listeners from old process so the daemon
        // doesn't treat this intentional stop as a crash.
        if (this.proc) {
            this.proc.removeAllListeners("exit");
            this.proc.removeAllListeners("error");
        }
        await this.stop();
        this.start();
    }

    async stop(): Promise<void> {
        if (!this.proc) return;
        const p = this.proc;
        this.proc = null;
        p.kill("SIGTERM");
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                p.kill("SIGKILL");
                resolve();
            }, 5000);
            p.on("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    get running(): boolean {
        return this.proc !== null && this.proc.exitCode === null;
    }

    get busy(): boolean {
        return this.responseQueue.length > 0;
    }

    cancelPending(reason?: string): void {
        const err = new Error(reason ?? "Cancelled");
        for (const { reject } of this.responseQueue) reject(err);
        this.responseQueue = [];
        this.responseText = "";
    }

    steer(text: string): void {
        if (!this.proc?.stdin?.writable) return;
        this.rpc("steer", { message: text }).catch((err) => {
            logger.error("Failed to steer", { error: String(err) });
        });
    }

    command(type: string, params: Record<string, unknown> = {}): Promise<any> {
        if (!this.proc?.stdin?.writable) {
            return Promise.reject(new Error("Pi process not running"));
        }
        return this.rpc(type, params);
    }

    private rpc(type: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = randomUUID();
        const line = JSON.stringify({ id, type, ...params });
        logger.info("Bridge RPC send", { type, id: id.slice(0, 8) });
        return new Promise((resolve, reject) => {
            this.rpcPending.set(id, { resolve, reject });
            this.proc!.stdin!.write(line + "\n");
        });
    }

    private onData(data: string): void {
        this.buffer += data;
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                this.onEvent(JSON.parse(line));
            } catch {
                // not JSON, skip
            }
        }
    }

    private onEvent(event: any): void {
        logger.info("Bridge event", { type: event.type, sub: event.assistantMessageEvent?.type });

        // RPC response to a command we sent
        if (event.type === "response" && event.id && this.rpcPending.has(event.id)) {
            const pending = this.rpcPending.get(event.id)!;
            this.rpcPending.delete(event.id);
            event.success ? pending.resolve(event.data) : pending.reject(new Error(event.error ?? "RPC error"));
            return;
        }

        // Tool execution started — flush accumulated text, then notify
        if (event.type === "tool_execution_start") {
            const current = this.responseQueue[0];
            if (current) {
                // Flush intermediate text before tool call
                const text = this.responseText.trim();
                if (current.onText) {
                    // Interactive path: send intermediate text to listener immediately
                    if (text) current.onText(text);
                    this.responseText = "";
                }
                // No onText (e.g. cron): keep accumulating into responseText
                // so the full response is available at agent_end

                if (current.onToolStart) {
                    current.onToolStart({
                        toolName: event.toolName,
                        args: event.args ?? {},
                    });
                }
            }
        }

        // Tool execution ended — notify for outbound file handling
        if (event.type === "tool_execution_end") {
            const current = this.responseQueue[0];
            if (current?.onToolEnd) {
                current.onToolEnd({
                    toolName: event.toolName,
                    toolCallId: event.toolCallId ?? "",
                    result: event.result,
                    isError: event.isError ?? false,
                });
            }
        }

        // Accumulate assistant text deltas (streaming path)
        if (event.type === "message_update") {
            const delta = event.assistantMessageEvent;
            if (delta?.type === "text_delta") {
                this.responseText += delta.delta;
            }
        }

        // Fallback: extract text from message_end if no streaming deltas arrived
        // Some pi versions/models don't emit message_update events
        if (event.type === "message_end") {
            const msg = event.message;
            if (msg?.role === "assistant" && !this.responseText) {
                const textBlocks = Array.isArray(msg.content)
                    ? msg.content.filter((b: any) => b.type === "text")
                    : [];
                const text = textBlocks.map((b: any) => b.text).join("");
                if (text) {
                    this.responseText = text;
                }
            }
        }

        // Agent done — resolve oldest queued promise
        if (event.type === "agent_end") {
            const text = this.responseText.trim();
            this.responseText = "";
            const next = this.responseQueue.shift();
            if (next) next.resolve(text);
        }

        this.emit("event", event);
    }

    private rejectAll(err: Error): void {
        for (const { reject } of this.responseQueue) reject(err);
        this.responseQueue = [];
        for (const [, { reject }] of this.rpcPending) reject(err);
        this.rpcPending.clear();
    }
}
