// ─── Block Protocol ──────────────────────────────────────────

export interface Block {
    id: string;
    kind: string;
    data: Record<string, unknown>;
    fallback: string;
}

// ─── Core Message Types ───────────────────────────────────────

export interface Attachment {
    url: string;
    filename: string;
    contentType: string;
    size: number;
    data?: Buffer;
    base64?: string;
}

export interface OutgoingFile {
    data: Buffer;
    filename: string;
}

export interface IncomingMessage {
    platform: string;
    channel: string;
    sender: string;
    text: string;
    attachments?: Attachment[];
}

export interface MessageOrigin {
    platform: string;
    channel: string;
}

// ─── Listener Interface ──────────────────────────────────────

export interface Listener {
    readonly name: string;
    /** Whether this listener wants streaming text deltas. Default: false. */
    readonly streaming?: boolean;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    onMessage(handler: (msg: IncomingMessage) => void): void;
    send(origin: MessageOrigin, text: string, files?: OutgoingFile[], kind?: "text" | "tool" | "stream", blocks?: Block[]): Promise<void>;
    sendTyping?(origin: MessageOrigin): Promise<void>;
    /** Send an interactive prompt. Resolves when user responds or rejects on timeout/cancel. */
    sendPrompt?(origin: MessageOrigin, block: Block, timeoutMs: number): Promise<{ value: unknown } | { cancelled: true }>;
    /** Where to send unsolicited output (cron, etc.). Plugin reads its own config. */
    notifyOrigin?(): MessageOrigin | null;
}

// ─── Middleware Interface ────────────────────────────────────

export interface Middleware {
    readonly name: string;
    process(msg: IncomingMessage): Promise<IncomingMessage | null>;
}

// ─── Command Interface ──────────────────────────────────────

export interface Command {
    interrupts?: boolean;
    execute(ctx: CommandContext): Promise<void>;
}

export interface CommandContext {
    args: string;
    bridge: Bridge;
    reply: (text: string) => Promise<void>;
    sessionName: string;
    nest: NestAPI;
}

// ─── Route Handler ──────────────────────────────────────────

import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
export type RouteHandler = (req: HttpReq, res: ServerResponse) => void | Promise<void>;

// ─── Bridge Events ──────────────────────────────────────────

export interface ToolCallInfo {
    toolName: string;
    args: Record<string, any>;
}

export interface ToolEndInfo {
    toolName: string;
    toolCallId: string;
    result?: {
        content: Array<{ type: string; text?: string }>;
        details?: Record<string, any>;
    };
    isError: boolean;
}

// ─── Forward declarations (avoid circular imports) ──────────

import type { Bridge } from "./bridge.js";

// ─── Session Types ──────────────────────────────────────────

export type SessionState = "idle" | "starting" | "running" | "stopping";

export interface SessionConfig {
    pi: {
        cwd: string;
        command?: string;
        args?: string[];
        extensions?: string[];
        agentDir?: string;
    };
    idleTimeoutMinutes?: number;
}

// ─── Config ─────────────────────────────────────────────────

export interface ServerConfig {
    port: number;
    token: string;
    host?: string;
    trustProxy?: boolean;
    cors?: { origin: string };
}

export interface CronConfig {
    dir: string;
    gracePeriodMs?: number;
    notify?: string;            // comma-separated platform names (e.g. "discord, matrix")
}

export interface TrackingConfig {
    usageLog?: string;
    capacity?: number;
    retentionDays?: number;
}

// Sandbox config is intentionally minimal — the real configuration
// lives in docker-compose.yml, Dockerfile, and entrypoint.sh in the
// workspace directory. `nest init` generates these files.
// This type exists only so the kernel can detect sandbox mode.

export interface AttachConfig {
    /** Host to connect to for `nest attach` WebSocket. Default: 127.0.0.1 */
    host?: string;
}

export interface InstanceConfig {
    name: string;
    dataDir?: string;
    pluginsDir?: string;
    agentDir?: string;
    sandbox?: boolean;          // true = use docker-compose.yml in workspace
}

export interface Config {
    instance?: InstanceConfig;
    sessions: Record<string, SessionConfig>;
    defaultSession: string;
    server?: ServerConfig;
    cron?: CronConfig;
    tracking?: TrackingConfig;
    attach?: AttachConfig;      // host-side overrides for `nest attach` (Docker deployments)
    // Plugins read their own sections from here.
    // The kernel doesn't validate plugin config.
    [key: string]: unknown;
}

// ─── Usage Types ────────────────────────────────────────────

export interface UsageEvent {
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    contextSize: number;
    cost: number;
    compaction: boolean;
    sessionName?: string;
}

export interface UsageSummary {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    messageCount: number;
}

// ─── Cron Job Types ─────────────────────────────────────────

export type Step =
    | { type: "new-session" }
    | { type: "compact" }
    | { type: "model"; model: string }
    | { type: "prompt" }
    | { type: "reload" };

export interface JobDefinition {
    name: string;
    file: string;
    schedule: string;
    steps: Step[];
    enabled: boolean;
    gracePeriodMs?: number;
    session?: string;
    notify?: string;            // per-job override: comma-separated platform names
    body: string;
}

// ─── Activity ───────────────────────────────────────────────

export interface ActivityEntry {
    sender: string;
    platform: string;
    channel: string;
    timestamp: number;
    responseTimeMs: number;
}

// ─── NestAPI — The Plugin Interface ─────────────────────────

export interface NestAPI {
    // Registration
    registerListener(listener: Listener): void;
    registerMiddleware(middleware: Middleware): void;
    registerCommand(name: string, command: Command): void;
    registerRoute(method: string, path: string, handler: RouteHandler): void;
    registerPrefixRoute(method: string, prefix: string, handler: RouteHandler): void;
    registerUpgrade(path: string, handler: (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void): void;

    // Lifecycle events
    on(event: "message_in", handler: (msg: IncomingMessage) => void): void;
    on(event: "message_out", handler: (origin: MessageOrigin, text: string) => void): void;
    on(event: "session_start", handler: (name: string) => void): void;
    on(event: "session_stop", handler: (name: string) => void): void;
    on(event: "shutdown", handler: () => void): void;
    on(event: string, handler: (...args: any[]) => void): void;

    // Sessions
    sessions: {
        get(name: string): Bridge | null;
        getOrStart(name: string): Promise<Bridge>;
        stop(name: string): Promise<void>;
        list(): string[];
        getDefault(): string;
        recordActivity(name: string): void;
        attach(sessionName: string, listener: Listener, origin: MessageOrigin): void;
        detach(sessionName: string, listener: Listener): void;
        getListeners(sessionName: string): Array<{ listener: Listener; origin: MessageOrigin }>;
    };

    // Usage tracking
    tracker: {
        record(event: {
            model: string;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
            contextSize: number;
            cost: number;
            sessionName?: string;
        }): UsageEvent;
        today(): UsageSummary;
        todayBySession(name: string): UsageSummary;
        week(): { cost: number };
        currentModel(): string;
        currentContext(): number;
    };

    // Config — plugins grab their own sections
    config: Config;

    // Logging
    log: {
        info(message: string, data?: Record<string, unknown>): void;
        warn(message: string, data?: Record<string, unknown>): void;
        error(message: string, data?: Record<string, unknown>): void;
    };

    // Instance
    instance: {
        name: string;
        dataDir: string;
    };
}

// ─── Plugin Definition ──────────────────────────────────────

export type NestPlugin = (nest: NestAPI) => void | Promise<void>;
