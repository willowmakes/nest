import { EventEmitter } from "node:events";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge.js";
import type { BridgeOptions } from "./bridge.js";
import type { Config, SessionConfig, SessionState, Listener, MessageOrigin, Block } from "./types.js";
import * as logger from "./logger.js";

const __srcDir = dirname(fileURLToPath(import.meta.url));
import { discoverExtensions } from "./plugin-loader.js";

interface ListenerBinding {
    listener: Listener;
    origin: MessageOrigin;
}

export interface SessionInfo {
    name: string;
    state: SessionState;
    bridge: Bridge | null;
    config: SessionConfig;
    idleTimer: ReturnType<typeof setTimeout> | null;
    lastActivity: number;
    listeners: ListenerBinding[];
    /** The origin of the message currently being processed, if any. */
    activeOrigin: MessageOrigin | null;
}

/**
 * Sessions are the central concept.
 * Listeners attach to sessions. Cron jobs target sessions.
 * Multiple listeners on one session all see the same output.
 */
export class SessionManager extends EventEmitter {
    private sessions = new Map<string, SessionInfo>();
    private defaultSession: string;
    private bridgeFactory: (opts: BridgeOptions) => Bridge;
    private instanceAgentDir?: string;
    private config: Config;
    private nestContextBuilder?: () => string;

    constructor(config: Config, bridgeFactory?: (opts: BridgeOptions) => Bridge) {
        super();
        this.bridgeFactory = bridgeFactory ?? ((opts) => new Bridge(opts));
        this.defaultSession = config.defaultSession;
        this.instanceAgentDir = config.instance?.agentDir;
        this.config = config;

        for (const [name, sessionConfig] of Object.entries(config.sessions)) {
            this.sessions.set(name, {
                name,
                state: "idle",
                bridge: null,
                config: sessionConfig,
                idleTimer: null,
                lastActivity: 0,
                listeners: [],
                activeOrigin: null,
            });
        }
    }

    /**
     * Register a builder that generates the system prompt context on demand.
     * Called each time a session starts, so it always reflects current state.
     */
    setNestContextBuilder(builder: () => string): void {
        this.nestContextBuilder = builder;
    }

    // ─── Session Lifecycle ────────────────────────────────────

    async getOrStartSession(name: string): Promise<Bridge> {
        const info = this.sessions.get(name);
        if (!info) throw new Error(`Unknown session: ${name}`);

        if (info.state === "running" && info.bridge) {
            this.resetIdleTimer(info);
            return info.bridge;
        }

        if (info.state === "starting") {
            return new Promise((resolve, reject) => {
                const start = Date.now();
                const check = () => {
                    if (Date.now() - start > 30_000) {
                        reject(new Error(`Session ${name} start timeout`));
                        return;
                    }
                    if (info.state === "running" && info.bridge) {
                        resolve(info.bridge);
                    } else if (info.state === "idle" || info.state === "stopping") {
                        reject(new Error(`Session ${name} failed to start`));
                    } else {
                        setTimeout(check, 50);
                    }
                };
                setTimeout(check, 50);
            });
        }

        return this.startSession(name);
    }

    async startSession(name: string): Promise<Bridge> {
        const info = this.sessions.get(name);
        if (!info) throw new Error(`Unknown session: ${name}`);
        if (info.state === "running" && info.bridge) return info.bridge;

        info.state = "starting";
        logger.info("Starting session", { session: name });

        // Explicit --session-dir so kernel and `nest attach` share the same
        // conversation directory for a given session name.
        const agentDir = info.config.pi.agentDir ?? this.instanceAgentDir;
        const baseArgs = info.config.pi.args ?? ["--mode", "rpc", "--continue"];
        const args = [...baseArgs];

        // Auto-discover pi.ts extensions from plugin directories
        const pluginsDir = this.config.instance?.pluginsDir ?? "./plugins";
        const discovered = await discoverExtensions(pluginsDir);
        for (const ext of discovered) {
            args.push("-e", ext);
        }
        // Also add any explicitly configured extensions
        if (info.config.pi.extensions) {
            for (const ext of info.config.pi.extensions) {
                args.push("-e", ext);
            }
        }
        if (agentDir && !args.some((a) => a === "--session-dir")) {
            args.push("--session-dir", join(resolve(agentDir), "sessions", name));
        }

        // Build and append dynamic nest context to the system prompt.
        // Rebuilt on each session start so it reflects current state.
        if (this.nestContextBuilder) {
            const nestContext = this.nestContextBuilder();
            const existingIdx = args.indexOf("--append-system-prompt");
            if (existingIdx !== -1 && existingIdx + 1 < args.length) {
                args[existingIdx + 1] += "\n\n---\n\n" + nestContext;
            } else {
                args.push("--append-system-prompt", nestContext);
            }
        }

        let bridge: Bridge;
        try {
            // Pass NEST_URL and SERVER_TOKEN so pi extensions can reach the kernel
            const bridgeEnv: Record<string, string> = {};
            if (this.config.server?.port) {
                const host = this.config.server.host ?? "127.0.0.1";
                bridgeEnv.NEST_URL = `http://${host}:${this.config.server.port}`;
            }
            if (this.config.server?.token) {
                bridgeEnv.SERVER_TOKEN = this.config.server.token;
            }

            bridge = this.bridgeFactory({
                cwd: info.config.pi.cwd,
                command: info.config.pi.command,
                args,
                env: Object.keys(bridgeEnv).length > 0 ? bridgeEnv : undefined,
            });
            info.bridge = bridge;
            info.state = "running";
            info.lastActivity = Date.now();
            bridge.start();
        } catch (err) {
            info.state = "idle";
            info.bridge = null;
            throw err;
        }

        bridge.on("exit", (code: number, signal?: string) => {
            logger.info("Session bridge exited", { session: name, code, signal });
            info.state = "idle";
            info.bridge = null;
            this.clearIdleTimer(info);
            this.emit("session:exit", name, code, signal);
        });

        bridge.on("event", (event: any) => {
            this.emit("session:event", name, event);
        });

        this.resetIdleTimer(info);
        this.emit("session:start", name);
        logger.info("Session started", { session: name });
        return bridge;
    }

    async stopSession(name: string): Promise<void> {
        const info = this.sessions.get(name);
        if (!info || !info.bridge || info.state === "idle" || info.state === "stopping") return;

        info.state = "stopping";
        this.clearIdleTimer(info);
        logger.info("Stopping session", { session: name });

        try {
            info.bridge.removeAllListeners("exit");
            info.bridge.removeAllListeners("event");
            await info.bridge.stop();
        } catch (err) {
            logger.error("Error stopping session", { session: name, error: String(err) });
        } finally {
            info.bridge = null;
            info.state = "idle";
            this.emit("session:stop", name);
            logger.info("Session stopped", { session: name });
        }
    }

    async stopAll(): Promise<void> {
        await Promise.allSettled(
            Array.from(this.sessions.keys()).map((n) => this.stopSession(n)),
        );
    }

    // ─── Session Queries ─────────────────────────────────────

    getSession(name: string): Bridge | null {
        const info = this.sessions.get(name);
        if (!info || info.state !== "running") return null;
        return info.bridge;
    }

    getSessionInfo(name: string): SessionInfo | undefined {
        return this.sessions.get(name);
    }

    getSessionNames(): string[] {
        return Array.from(this.sessions.keys());
    }

    getDefaultSessionName(): string {
        return this.defaultSession;
    }

    setActiveOrigin(name: string, origin: MessageOrigin | null): void {
        const info = this.sessions.get(name);
        if (info) info.activeOrigin = origin;
    }

    getActiveOrigin(name: string): MessageOrigin | null {
        return this.sessions.get(name)?.activeOrigin ?? null;
    }

    recordActivity(name: string): void {
        const info = this.sessions.get(name);
        if (info) {
            info.lastActivity = Date.now();
            this.resetIdleTimer(info);
        }
    }

    // ─── Listener Attachment ─────────────────────────────────

    attach(sessionName: string, listener: Listener, origin: MessageOrigin): void {
        const info = this.sessions.get(sessionName);
        if (!info) throw new Error(`Unknown session: ${sessionName}`);

        // Avoid duplicates
        const existing = info.listeners.find(
            (b) => b.listener === listener && b.origin.platform === origin.platform && b.origin.channel === origin.channel,
        );
        if (existing) return;

        info.listeners.push({ listener, origin });
        logger.info("Listener attached to session", {
            session: sessionName,
            listener: listener.name,
            platform: origin.platform,
            channel: origin.channel,
        });
    }

    detach(sessionName: string, listener: Listener): void {
        const info = this.sessions.get(sessionName);
        if (!info) return;

        info.listeners = info.listeners.filter((b) => b.listener !== listener);
        logger.info("Listener detached from session", {
            session: sessionName,
            listener: listener.name,
        });
    }

    getListeners(sessionName: string): ListenerBinding[] {
        const info = this.sessions.get(sessionName);
        return info?.listeners ?? [];
    }

    /**
     * Broadcast a message to all listeners attached to a session.
     */
    async broadcast(
        sessionName: string,
        text: string,
        files?: import("./types.js").OutgoingFile[],
        replyOrigin?: import("./types.js").MessageOrigin,
        kind?: "text" | "tool" | "stream",
        blocks?: Block[],
    ): Promise<void> {
        // If no explicit replyOrigin, check if the session has an active origin
        // (set by handleMessage while processing a user message).
        const effectiveOrigin = replyOrigin ?? this.getActiveOrigin(sessionName);

        const bindings = this.getListeners(sessionName);
        for (const { listener, origin } of bindings) {
            // Only deliver stream deltas to listeners that opted in.
            if (kind === "stream" && !listener.streaming) continue;

            // Resolve wildcard channels: use the actual message origin
            // when the binding uses "*" (meaning "all channels").
            // Skip the send entirely if wildcard can't be resolved
            // (e.g. CLI message → Discord listener with channel "*").
            let resolvedOrigin = origin;
            if (origin.channel === "*") {
                if (effectiveOrigin && effectiveOrigin.platform === origin.platform) {
                    resolvedOrigin = effectiveOrigin;
                } else if (effectiveOrigin) {
                    // Different platform — can't resolve wildcard, skip
                    continue;
                } else {
                    // No origin at all (cron, etc.) — fall back to notifyOrigin
                    const notify = listener.notifyOrigin?.();
                    if (notify) {
                        resolvedOrigin = notify;
                    } else {
                        continue;
                    }
                }
            }

            try {
                await listener.send(resolvedOrigin, text, files, kind, blocks);
            } catch (err) {
                logger.error("Broadcast send failed", {
                    session: sessionName,
                    listener: listener.name,
                    error: String(err),
                });
            }
        }
    }

    // ─── Idle Timeout ────────────────────────────────────────

    private resetIdleTimer(info: SessionInfo): void {
        this.clearIdleTimer(info);
        const timeout = info.config.idleTimeoutMinutes;
        if (!timeout || timeout <= 0) return;

        info.idleTimer = setTimeout(() => {
            if (info.state === "running" && info.bridge && !info.bridge.busy) {
                logger.info("Session idle timeout", { session: info.name });
                this.stopSession(info.name).catch(() => {});
            } else if (info.bridge?.busy) {
                this.resetIdleTimer(info);
            }
        }, timeout * 60_000);
    }

    private clearIdleTimer(info: SessionInfo): void {
        if (info.idleTimer) {
            clearTimeout(info.idleTimer);
            info.idleTimer = null;
        }
    }
}
