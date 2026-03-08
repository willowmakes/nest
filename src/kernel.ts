import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { EventEmitter } from "node:events";
import { Bridge } from "./bridge.js";
import type { ImageContent } from "./bridge.js";
import { SessionManager } from "./session-manager.js";
import { Tracker } from "./tracker.js";
import { HttpServer } from "./server.js";
import { Scheduler } from "./scheduler.js";
import { loadPlugins } from "./plugin-loader.js";
import type {
    Config, NestAPI, Listener, Middleware, Command, IncomingMessage,
    MessageOrigin, ToolCallInfo, ToolEndInfo, OutgoingFile, Attachment,
    ActivityEntry, JobDefinition, RouteHandler,
} from "./types.js";
import * as logger from "./logger.js";
import { cleanupInbox, saveToInbox } from "./inbox.js";
import { compressImage } from "./image.js";

const COMMAND_PREFIX = "bot!";
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const MAX_MESSAGE_LENGTH = 4000;
const ACTIVITY_CAPACITY = 50;

function formatToolCall(info: ToolCallInfo): string {
    const { toolName, args } = info;
    switch (toolName) {
        case "read": return `📖 Reading \`${args?.path ?? "file"}\``;
        case "bash": {
            const cmd = String(args?.command ?? "");
            const first = cmd.split("\n")[0];
            return `⚡ \`${first.length > 80 ? first.slice(0, 80) + "…" : first}\``;
        }
        case "edit": return `✏️ Editing \`${args?.path ?? "file"}\``;
        case "write": return `📝 Writing \`${args?.path ?? "file"}\``;
        default: return `🔧 ${toolName}`;
    }
}

export class Kernel {
    private config: Config;
    private sessionManager: SessionManager;
    private tracker: Tracker;
    private httpServer?: HttpServer;
    private scheduler?: Scheduler;
    private events = new EventEmitter();

    // Plugin registrations
    private listeners: Listener[] = [];
    private middlewares: Middleware[] = [];
    private commands = new Map<string, Command>();
    private pluginNames: string[] = [];

    // Runtime state
    private stopping = false;
    private commandRunning = false;
    private rateLimits = new Map<string, number[]>();
    private lastUserInteractionTime = 0;
    private startedAt = Date.now();
    private activityBuffer: ActivityEntry[] = [];

    constructor(config: Config, sessionManager?: SessionManager) {
        this.config = config;
        this.sessionManager = sessionManager ?? new SessionManager(config);
        this.tracker = new Tracker(config.tracking);

        // Register core commands
        this.registerCoreCommands();
    }

    // ─── NestAPI — what plugins see ──────────────────────────

    private buildAPI(): NestAPI {
        const sm = this.sessionManager;
        const tracker = this.tracker;
        const config = this.config;
        const inst = config.instance!;
        const kernel = this;

        return {
            registerListener: (l) => kernel.listeners.push(l),
            registerMiddleware: (m) => kernel.middlewares.push(m),
            registerCommand: (name, cmd) => kernel.commands.set(name, cmd),
            registerRoute: (method, path, handler) => kernel.httpServer?.route(method, path, handler),
            registerPrefixRoute: (method, prefix, handler) => kernel.httpServer?.prefixRoute(method, prefix, handler),
            registerUpgrade: (path, handler) => kernel.httpServer?.onUpgrade(path, handler),

            on: (event: string, handler: (...args: any[]) => void) => kernel.events.on(event, handler),

            sessions: {
                get: (name) => sm.getSession(name),
                getOrStart: (name) => sm.getOrStartSession(name),
                stop: (name) => sm.stopSession(name),
                list: () => sm.getSessionNames(),
                getDefault: () => sm.getDefaultSessionName(),
                recordActivity: (name) => sm.recordActivity(name),
                attach: (session, listener, origin) => sm.attach(session, listener, origin),
                detach: (session, listener) => sm.detach(session, listener),
                getListeners: (session) => sm.getListeners(session),
            },

            tracker: {
                record: (e) => tracker.record(e),
                today: () => tracker.today(),
                todayBySession: (name) => tracker.todayBySession(name),
                week: () => tracker.week(),
                currentModel: () => tracker.currentModel(),
                currentContext: () => tracker.currentContext(),
            },

            config,

            log: {
                info: logger.info,
                warn: logger.warn,
                error: logger.error,
            },

            instance: {
                name: inst.name ?? "nest",
                dataDir: inst.dataDir ?? ".",
            },
        };
    }

    // ─── Core Commands ───────────────────────────────────────

    private registerCoreCommands(): void {
        this.commands.set("status", {
            async execute({ reply, nest }) {
                const uptime = Math.floor((Date.now() - nest.tracker.currentContext()) / 1000);
                const sessions = nest.sessions.list();
                const model = nest.tracker.currentModel();
                const today = nest.tracker.today();
                const lines = [
                    `🪹 nest | model ${model} | sessions: ${sessions.join(", ")}`,
                ];
                if (today.messageCount > 0) {
                    lines.push(`📊 today: $${today.cost.toFixed(2)} | ${today.messageCount} msgs`);
                }
                await reply(lines.join("\n"));
            },
        });

        this.commands.set("reboot", {
            interrupts: true,
            async execute({ args, bridge, reply, sessionName, nest }) {
                const target = args.trim() || sessionName;
                if (target === "all") {
                    const names = nest.sessions.list();
                    await reply(`🔄 Rebooting ${names.length} session(s)...`);
                    for (const name of names) {
                        try {
                            await nest.sessions.stop(name);
                            await nest.sessions.getOrStart(name);
                        } catch (err) {
                            await reply(`❌ **${name}**: ${String(err)}`);
                        }
                    }
                    await reply("✅ Done.");
                } else {
                    await reply(`🔄 Rebooting session **${target}**...`);
                    await bridge.restart();
                    await reply(`✅ Session **${target}** rebooted.`);
                }
            },
        });

        this.commands.set("abort", {
            interrupts: true,
            async execute({ bridge, reply }) {
                await bridge.command("abort");
                await reply("⏹️ Aborted.");
            },
        });
    }

    // ─── Boot ────────────────────────────────────────────────

    async start(): Promise<void> {
        await this.tracker.loadLog();

        // Wire session events
        this.sessionManager.on("session:event", (session: string, event: any) => {
            if (event.type === "message_end") {
                this.recordUsage(event, session);
            }
            this.httpServer?.broadcastEvent({ ...event, session });
        });

        this.sessionManager.on("session:exit", (session: string, code: number) => {
            if (this.stopping) return;
            logger.warn("Session exited unexpectedly", { session, code });
        });

        this.sessionManager.on("session:start", (name: string) => {
            this.events.emit("session_start", name);
        });

        this.sessionManager.on("session:stop", (name: string) => {
            this.events.emit("session_stop", name);
        });

        // Create HTTP server if configured
        if (this.config.server) {
            this.httpServer = new HttpServer(this.config.server);
        }

        // Build API and load plugins
        const api = this.buildAPI();
        const pluginsDir = this.config.instance?.pluginsDir ?? "./plugins";
        this.pluginNames = await loadPlugins(pluginsDir, api);
        logger.info("Plugins loaded", { count: this.pluginNames.length, names: this.pluginNames });

        // Connect all registered listeners
        for (const listener of this.listeners) {
            listener.onMessage((msg) => this.handleMessage(msg));
            await listener.connect();
        }

        // Start scheduler if configured
        if (this.config.cron) {
            const defaultBridge = await this.sessionManager.getOrStartSession(
                this.sessionManager.getDefaultSessionName(),
            );
            this.scheduler = new Scheduler(this.config.cron, defaultBridge, () => this.lastUserInteractionTime);
            this.scheduler.setSessionManager(this.sessionManager);

            // Wire scheduler events — send to notify targets
            const notifySend = (job: JobDefinition, text: string, files?: OutgoingFile[]) => {
                this.sendToNotifyTargets(job, text, files);
            };

            this.scheduler.on("response", ({ job, response }: { job: JobDefinition; response: string }) => {
                notifySend(job, response);
            });

            this.scheduler.on("text", ({ job, text }: { job: JobDefinition; text: string }) => {
                notifySend(job, text);
            });

            this.scheduler.on("aborted", ({ job }: { job: JobDefinition }) => {
                notifySend(job, `⏹️ Cron job \`${job.name}\` aborted.`);
            });

            this.scheduler.on("tool-start", ({ job, info }: { job: JobDefinition; info: ToolCallInfo }) => {
                notifySend(job, formatToolCall(info));
            });

            await this.scheduler.start();
        }

        // Start HTTP server
        if (this.httpServer) {
            await this.httpServer.start();
        }

        logger.info("nest started", {
            instance: this.config.instance?.name,
            listeners: this.listeners.length,
            plugins: this.pluginNames.length,
            sessions: this.sessionManager.getSessionNames(),
        });
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.events.emit("shutdown");

        if (this.httpServer) await this.httpServer.stop();
        if (this.scheduler) await this.scheduler.stop();

        for (const listener of this.listeners) {
            await listener.disconnect().catch(() => {});
        }

        await this.sessionManager.stopAll();
    }

    // ─── Message Handling ────────────────────────────────────

    private async handleMessage(msg: IncomingMessage): Promise<void> {
        if (msg.text.length > MAX_MESSAGE_LENGTH) {
            logger.warn("Dropped oversized message", { sender: msg.sender, length: msg.text.length });
            return;
        }

        if (this.isRateLimited(msg.sender)) {
            logger.warn("Rate limited", { sender: msg.sender });
            return;
        }

        // Run middleware pipeline
        let processed: IncomingMessage | null = msg;
        for (const mw of this.middlewares) {
            processed = await mw.process(processed);
            if (!processed) {
                logger.info("Message blocked by middleware", { middleware: mw.name, sender: msg.sender });
                return;
            }
        }
        msg = processed;

        this.lastUserInteractionTime = Date.now();
        this.events.emit("message_in", msg);

        // Find which listener sent this and resolve reply
        const origin: MessageOrigin = { platform: msg.platform, channel: msg.channel };
        const listener = this.listeners.find((l) => l.name === msg.platform);
        const reply = async (text: string) => {
            if (listener) await listener.send(origin, text).catch(() => {});
        };

        // Find which session this message routes to via attachment bindings
        const sessionName = this.resolveSessionForMessage(msg);

        // Handle bot commands
        const parsed = this.parseCommand(msg.text);
        if (parsed) {
            const command = this.commands.get(parsed.name);
            if (!command) return;

            let bridge: Bridge;
            try {
                bridge = await this.sessionManager.getOrStartSession(sessionName);
            } catch (err) {
                await reply(`❌ Session error: ${String(err)}`);
                return;
            }

            if (command.interrupts) bridge.cancelPending(`Interrupted by bot!${parsed.name}`);

            this.commandRunning = true;
            try {
                await command.execute({
                    args: parsed.args,
                    bridge,
                    reply,
                    sessionName,
                    nest: this.buildAPI(),
                });
            } catch (err) {
                await reply(`❌ Command failed: ${String(err)}`);
            } finally {
                this.commandRunning = false;
            }
            return;
        }

        // Process attachments
        const { images, fileLines } = await this.processAttachments(msg.attachments);

        let promptText = `[${msg.platform} ${msg.channel}] ${msg.sender}: ${msg.text}`;
        if (fileLines.length > 0) promptText += "\n" + fileLines.join("\n");

        if (this.commandRunning) {
            await reply("⏳ Hold on, running a command...");
            return;
        }

        let bridge: Bridge;
        try {
            bridge = await this.sessionManager.getOrStartSession(sessionName);
        } catch (err) {
            await reply(`❌ Failed to start session: ${String(err)}`);
            return;
        }

        this.sessionManager.recordActivity(sessionName);

        if (bridge.busy) {
            bridge.steer(promptText);
            return;
        }

        // Typing indicator
        const typingInterval = this.startTyping(listener, origin);

        const pendingFiles: OutgoingFile[] = [];
        const pendingReads: Promise<void>[] = [];
        const activityStart = Date.now();

        try {
            const response = await bridge.sendMessage(promptText, {
                images: images.length > 0 ? images : undefined,
                onToolStart: (info) => {
                    const summary = formatToolCall(info);
                    this.sessionManager.broadcast(sessionName, summary, undefined, origin, "tool").catch(() => {});
                },
                onToolEnd: (info: ToolEndInfo) => {
                    if (info.toolName === "attach" && !info.isError && info.result?.details) {
                        const filePath = info.result.details.path;
                        if (typeof filePath === "string") {
                            pendingReads.push(this.queueAttachFile(filePath, info.result.details.filename, pendingFiles));
                        }
                    }
                },
                onText: (text) => {
                    this.sessionManager.broadcast(sessionName, text, undefined, origin, "stream").catch(() => {});
                },
            });

            if (!response) return;

            await Promise.all(pendingReads);

            // Broadcast final response to all attached listeners
            this.events.emit("message_out", origin, response);
            await this.sessionManager.broadcast(sessionName, response, pendingFiles.length > 0 ? pendingFiles : undefined, origin);
        } catch (err) {
            logger.error("Failed to process message", { error: String(err), session: sessionName });
        } finally {
            this.recordActivity(msg, Date.now() - activityStart);
            clearInterval(typingInterval);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────

    /**
     * Resolve which session a message should go to by checking
     * listener attachments. Falls back to default session.
     */
    private resolveSessionForMessage(msg: IncomingMessage): string {
        for (const name of this.sessionManager.getSessionNames()) {
            const bindings = this.sessionManager.getListeners(name);
            for (const { listener, origin } of bindings) {
                if (listener.name === msg.platform && origin.channel === msg.channel) {
                    return name;
                }
            }
        }
        return this.sessionManager.getDefaultSessionName();
    }

    private parseCommand(text: string): { name: string; args: string } | null {
        if (!text.toLowerCase().startsWith(COMMAND_PREFIX)) return null;
        const rest = text.slice(COMMAND_PREFIX.length).trim();
        if (!rest) return null;
        const [rawName, ...argParts] = rest.split(/\s+/);
        const name = rawName.toLowerCase();
        if (!this.commands.has(name)) return null;
        return { name, args: argParts.join(" ") };
    }

    private recordUsage(event: any, sessionName: string): void {
        const msg = event.message;
        if (!msg || msg.role !== "assistant") return;
        const usage = msg.usage ?? {};
        this.tracker.record({
            model: msg.model ?? "unknown",
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
            cacheReadTokens: usage.cacheRead ?? 0,
            cacheWriteTokens: usage.cacheWrite ?? 0,
            contextSize: usage.totalTokens || 0,
            cost: usage.cost?.total ?? 0,
            sessionName,
        });
    }

    private async processAttachments(attachments?: Attachment[]): Promise<{ images: ImageContent[]; fileLines: string[] }> {
        const images: ImageContent[] = [];
        const fileLines: string[] = [];
        if (!attachments?.length) return { images, fileLines };

        cleanupInbox().catch(() => {});

        for (const att of attachments) {
            if (att.base64 && att.contentType.startsWith("image/")) {
                const compressed = att.data ? await compressImage(att.data, att.contentType) : null;
                if (compressed && !compressed.ok) {
                    fileLines.push(`[${compressed.reason}]`);
                } else if (compressed?.ok) {
                    images.push({ type: "image", data: compressed.base64, mimeType: compressed.mimeType });
                } else {
                    images.push({ type: "image", data: att.base64, mimeType: att.contentType });
                }
            } else if (att.data) {
                const saved = await saveToInbox(att.filename, att.data);
                if (saved) fileLines.push(`[Attached file: ${saved} (${att.contentType}, ${att.size} bytes)]`);
            }
        }

        return { images, fileLines };
    }

    private async queueAttachFile(filePath: string, filename: string | undefined, pendingFiles: OutgoingFile[]): Promise<void> {
        try {
            const data = await readFile(filePath);
            pendingFiles.push({ data, filename: filename ?? basename(filePath) });
        } catch (err) {
            logger.error("Failed to read attach file", { path: filePath, error: String(err) });
        }
    }

    private startTyping(listener: Listener | undefined, origin: MessageOrigin): ReturnType<typeof setInterval> {
        const send = () => listener?.sendTyping?.(origin).catch(() => {});
        send();
        return setInterval(send, 8_000);
    }

    private isRateLimited(sender: string): boolean {
        const now = Date.now();
        const timestamps = this.rateLimits.get(sender) ?? [];
        const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
        if (recent.length >= RATE_MAX) {
            this.rateLimits.set(sender, recent);
            return true;
        }
        recent.push(now);
        this.rateLimits.set(sender, recent);
        return false;
    }

    private recordActivity(msg: IncomingMessage, responseTimeMs: number): void {
        if (this.activityBuffer.length >= ACTIVITY_CAPACITY) this.activityBuffer.shift();
        this.activityBuffer.push({
            sender: msg.sender,
            platform: msg.platform,
            channel: msg.channel,
            timestamp: Date.now(),
            responseTimeMs,
        });
    }

    // ─── Cron Notify ────────────────────────────────────────

    private sendToNotifyTargets(job: JobDefinition, text: string, files?: OutgoingFile[]): void {
        const notifyStr = job.notify ?? this.config.cron?.notify;
        if (!notifyStr) {
            logger.warn("Cron job has no notify target, dropping output", { job: job.name });
            return;
        }

        const platforms = notifyStr.split(",").map((s) => s.trim()).filter(Boolean);

        for (const platform of platforms) {
            const listener = this.listeners.find((l) => l.name === platform);
            if (!listener) {
                logger.warn("Notify target not found", { job: job.name, platform });
                continue;
            }

            const origin = listener.notifyOrigin?.();
            if (!origin) {
                logger.warn("Listener has no notify origin configured", { job: job.name, platform });
                continue;
            }

            listener.send(origin, text, files).catch((err) => {
                logger.error("Failed to send cron notification", {
                    job: job.name,
                    platform,
                    error: String(err),
                });
            });
        }
    }

    // ─── Accessors for server/dashboard ──────────────────────

    getActivityBuffer(): ActivityEntry[] { return [...this.activityBuffer]; }
    getTracker(): Tracker { return this.tracker; }
    getSessionManager(): SessionManager { return this.sessionManager; }
    getScheduler(): Scheduler | undefined { return this.scheduler; }
    getStartedAt(): number { return this.startedAt; }
    getListenerCount(): number { return this.listeners.length; }
    getPluginNames(): string[] { return [...this.pluginNames]; }
}
