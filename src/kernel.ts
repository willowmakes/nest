import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { Bridge } from "./bridge.js";

import { SessionManager } from "./session-manager.js";
import { Tracker } from "./tracker.js";
import { HttpServer } from "./server.js";
import { Scheduler } from "./scheduler.js";
import { loadPlugins } from "./plugin-loader.js";
import type {
    Config, NestAPI, Listener, Middleware, Command, IncomingMessage,
    MessageOrigin, ToolCallInfo, ToolEndInfo, OutgoingFile, Attachment,
    ActivityEntry, JobDefinition, RouteHandler, Block,
} from "./types.js";
import * as logger from "./logger.js";
import { cleanupInbox, saveToInbox } from "./inbox.js";


/**
 * Minimal multipart/form-data parser. Handles text fields and binary file parts.
 */
function parseMultipart(body: Buffer, boundary: string): Map<string, string | Buffer> {
    const fields = new Map<string, string | Buffer>();
    const sep = Buffer.from(`--${boundary}`);
    const parts: Buffer[] = [];
    let start = 0;

    // Split body on boundary markers
    while (true) {
        const idx = body.indexOf(sep, start);
        if (idx === -1) break;
        if (start > 0) {
            // Trim trailing \r\n before boundary
            let end = idx;
            if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;
            parts.push(body.subarray(start, end));
        }
        start = idx + sep.length;
        // Skip \r\n after boundary
        if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
        // Check for closing --
        if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    }

    for (const part of parts) {
        // Headers end at first \r\n\r\n
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const headerStr = part.subarray(0, headerEnd).toString();
        const content = part.subarray(headerEnd + 4);

        const nameMatch = headerStr.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const name = nameMatch[1];

        const filenameMatch = headerStr.match(/filename="([^"]+)"/);
        if (filenameMatch) {
            // Binary file part
            fields.set(name, Buffer.from(content));
        } else {
            // Text field
            fields.set(name, content.toString().trim());
        }
    }

    return fields;
}

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
    private coreCommands = new Set<string>();
    private pluginNames: string[] = [];

    // Block data store — binary data keyed by block ID, with TTL eviction
    private blockStore = new Map<string, { data: Buffer; mimeType: string; createdAt: number }>();
    private readonly BLOCK_TTL_MS = 5 * 60_000; // 5 minutes

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
        const self = this;
        this.coreCommands.add("status");
        this.coreCommands.add("reboot");
        this.coreCommands.add("reload");
        this.coreCommands.add("abort");

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

        this.commands.set("reload", {
            interrupts: true,
            async execute({ reply, sessionName }) {
                await reply("🔄 Reloading all plugins...");
                const { loaded, errors } = await self.reloadPlugins();
                // After reload, listeners are new instances. Broadcast status
                // to all listeners on this session so the user sees the result.
                const status = errors.length > 0
                    ? `⚠️ Reloaded with errors:\n${errors.join("\n")}`
                    : `✅ Loaded ${loaded.length} plugin(s): ${loaded.join(", ")}`;
                await self.sessionManager.broadcast(sessionName, status);
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

    // ─── Block Protocol Routes ──────────────────────────────

    private registerBlockRoutes(): void {
        const kernel = this;
        const server = this.httpServer!;
        const sm = this.sessionManager;
        const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

        // POST /api/block — send a display block or interactive prompt
        // Set prompt: true in the request body to hold the connection open for a response.
        server.route("POST", "/api/block", async (req, res) => {
            const body = await server.readJsonBody(req, res);
            if (!body) return;
            if (!body.block) {
                server.json(res, 400, { error: "Missing field: block" });
                return;
            }

            const sessionName: string = body.session ?? sm.getDefaultSessionName();
            const block: Block = body.block;
            const timeoutMs: number = body.timeout ?? 30_000;
            const isPrompt: boolean = body.prompt === true;

            if (isPrompt) {
                const replyOrigin = body.origin as { platform: string; channel: string } | undefined
                    ?? sm.getActiveOrigin(sessionName) ?? undefined;
                const listeners = sm.getListeners(sessionName);
                let responded = false;

                const timeout = setTimeout(() => {
                    if (!responded) {
                        responded = true;
                        server.json(res, 200, { ok: false, error: "timeout", timeout: timeoutMs });
                    }
                }, timeoutMs);

                // Find listener matching replyOrigin platform, fall back to first with sendPrompt
                const target = replyOrigin
                    ? listeners.find(({ listener }) =>
                        listener.sendPrompt && listener.name === replyOrigin.platform)
                    : listeners.find(({ listener }) => listener.sendPrompt);

                if (target?.listener.sendPrompt) {
                    try {
                        // Use the request's origin (real channel ID) over the binding origin (may be wildcard)
                        const promptOrigin: MessageOrigin = replyOrigin
                            ? { platform: replyOrigin.platform, channel: replyOrigin.channel }
                            : target.origin;
                        const result = await target.listener.sendPrompt(promptOrigin, block, timeoutMs);
                        if (!responded) {
                            responded = true;
                            clearTimeout(timeout);
                            server.json(res, 200, { ok: true, ...result });
                        }
                    } catch (err) {
                        logger.error("Prompt failed", { error: String(err), listener: target.listener.name });
                        if (!responded) {
                            responded = true;
                            clearTimeout(timeout);
                            server.json(res, 200, { ok: false, error: "prompt failed" });
                        }
                    }
                } else {
                    // No listener supports prompts — broadcast fallback text
                    clearTimeout(timeout);
                    await sm.broadcast(sessionName, block.fallback);
                    server.json(res, 200, { ok: false, error: "no interactive listener" });
                }
            } else {
                // Display block — broadcast to all listeners and return immediately
                await sm.broadcast(sessionName, block.fallback, undefined, undefined, "text", [block]);
                server.json(res, 200, { ok: true });
            }
        });

        // POST /api/block/upload — multipart binary image upload
        server.route("POST", "/api/block/upload", async (req, res) => {
            const contentType = req.headers["content-type"] ?? "";
            if (!contentType.includes("multipart/form-data")) {
                server.json(res, 400, { error: "Expected multipart/form-data" });
                return;
            }

            // Parse multipart boundary
            const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
            if (!boundaryMatch) {
                server.json(res, 400, { error: "Missing boundary" });
                return;
            }

            try {
                const rawBody = await new Promise<Buffer>((resolve, reject) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    req.on("data", (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > MAX_UPLOAD_SIZE) {
                            req.destroy();
                            reject(new Error("Payload too large"));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    req.on("end", () => resolve(Buffer.concat(chunks)));
                    req.on("error", reject);
                });

                const boundary = boundaryMatch[1];
                const fields = parseMultipart(rawBody, boundary);

                const session = fields.get("session")?.toString() ?? sm.getDefaultSessionName();
                const id = fields.get("id")?.toString() ?? `img-${Date.now()}`;
                const filename = fields.get("filename")?.toString() ?? "image.png";
                const mimeType = fields.get("mimeType")?.toString() ?? "image/png";
                const fallback = fields.get("fallback")?.toString() ?? `[Image: ${filename}]`;
                const maxWidth = fields.get("maxWidth")?.toString();
                const maxHeight = fields.get("maxHeight")?.toString();
                const file = fields.get("file");

                if (!file || !(file instanceof Buffer)) {
                    server.json(res, 400, { error: "Missing field: file" });
                    return;
                }

                const kind = fields.get("kind")?.toString() ?? "image";

                // Store binary data and pass a reference URL in the block
                kernel.blockStore.set(id, { data: file, mimeType, createdAt: Date.now() });
                kernel.evictExpiredBlocks();

                const data: Record<string, unknown> = {
                    ref: `/api/block/data/${id}`,
                    mimeType,
                    filename,
                    size: file.length,
                };
                if (maxWidth) data.maxWidth = parseInt(maxWidth, 10);
                if (maxHeight) data.maxHeight = parseInt(maxHeight, 10);

                const block: Block = { id, kind, data, fallback };
                await sm.broadcast(session, fallback, undefined, undefined, "text", [block]);
                server.json(res, 200, { ok: true });
            } catch (err) {
                if (!res.headersSent) {
                    server.json(res, 500, { error: String(err) });
                }
            }
        });

        // POST /api/block/update — update an existing block in-place
        server.route("POST", "/api/block/update", async (req, res) => {
            const body = await server.readJsonBody(req, res);
            if (!body) return;
            if (!body.id) {
                server.json(res, 400, { error: "Missing field: id" });
                return;
            }

            const sessionName: string = body.session ?? sm.getDefaultSessionName();
            const bindings = sm.getListeners(sessionName);
            for (const { listener, origin } of bindings) {
                try {
                    await listener.send(origin, body.fallback ?? "", undefined, "text", [{
                        id: body.id,
                        kind: "__update",
                        data: body.data ?? {},
                        fallback: body.fallback ?? "",
                    }]);
                } catch (err) {
                    logger.error("Block update send failed", { error: String(err) });
                }
            }
            server.json(res, 200, { ok: true });
        });

        // POST /api/block/remove — remove a block
        server.route("POST", "/api/block/remove", async (req, res) => {
            const body = await server.readJsonBody(req, res);
            if (!body) return;
            if (!body.id) {
                server.json(res, 400, { error: "Missing field: id" });
                return;
            }

            const sessionName: string = body.session ?? sm.getDefaultSessionName();
            const bindings = sm.getListeners(sessionName);
            for (const { listener, origin } of bindings) {
                try {
                    await listener.send(origin, "", undefined, "text", [{
                        id: body.id,
                        kind: "__remove",
                        data: {},
                        fallback: "",
                    }]);
                } catch (err) {
                    logger.error("Block remove send failed", { error: String(err) });
                }
            }
            server.json(res, 200, { ok: true });
        });

        // GET /api/block/data/:id — fetch raw binary data for a block
        server.prefixRoute("GET", "/api/block/data/", (req, res) => {
            const id = req.url?.replace("/api/block/data/", "").split("?")[0];
            if (!id) {
                server.json(res, 400, { error: "Missing block ID" });
                return;
            }

            const entry = kernel.blockStore.get(id);
            if (!entry) {
                server.json(res, 404, { error: "Block not found or expired" });
                return;
            }

            res.writeHead(200, {
                "Content-Type": entry.mimeType,
                "Content-Length": entry.data.length,
            });
            res.end(entry.data);
        });
    }

    private evictExpiredBlocks(): void {
        const now = Date.now();
        for (const [id, entry] of this.blockStore) {
            if (now - entry.createdAt > this.BLOCK_TTL_MS) {
                this.blockStore.delete(id);
            }
        }
    }

    // ─── Command API Routes ─────────────────────────────────

    private registerCommandRoutes(): void {
        const server = this.httpServer!;
        const sm = this.sessionManager;
        const kernel = this;

        // GET /api/commands — list available commands
        server.route("GET", "/api/commands", (_req, res) => {
            const cmds = Array.from(kernel.commands.keys());
            server.json(res, 200, { commands: cmds });
        });

        // POST /api/command — execute a named command
        server.route("POST", "/api/command", async (req, res) => {
            const body = await server.readJsonBody(req, res);
            if (!body?.command || typeof body.command !== "string") {
                server.json(res, 400, { error: "Missing field: command" });
                return;
            }

            const command = kernel.commands.get(body.command);
            if (!command) {
                server.json(res, 404, { error: `Unknown command: ${body.command}` });
                return;
            }

            const sessionName: string = body.session ?? sm.getDefaultSessionName();
            let bridge;
            try {
                bridge = await sm.getOrStartSession(sessionName);
            } catch (err) {
                server.json(res, 500, { error: `Session error: ${String(err)}` });
                return;
            }

            if (command.interrupts) bridge.cancelPending(`Interrupted by API ${body.command}`);

            const replies: string[] = [];
            try {
                await command.execute({
                    args: body.args ?? "",
                    bridge,
                    reply: async (text) => { replies.push(text); },
                    sessionName,
                    nest: kernel.buildAPI(),
                });
                server.json(res, 200, { ok: true, replies });
            } catch (err) {
                server.json(res, 500, { ok: false, error: String(err), replies });
            }
        });
    }

    // ─── Boot ────────────────────────────────────────────────

    // ─── Dynamic System Prompt ─────────────────────────────

    buildNestContext(): string {
        const inst = this.config.instance;
        const name = inst?.name ?? "nest";
        const sessions = this.sessionManager.getSessionNames();
        const defaultSession = this.sessionManager.getDefaultSessionName();

        // Listener summary: who's connected and to what session
        const listenerLines: string[] = [];
        for (const session of sessions) {
            const bindings = this.sessionManager.getListeners(session);
            for (const { listener, origin } of bindings) {
                listenerLines.push(`- **${listener.name}** → session \`${session}\` (${origin.platform}/${origin.channel})`);
            }
        }

        // Plugins
        const pluginList = this.pluginNames.length > 0
            ? this.pluginNames.join(", ")
            : "none";

        // Commands
        const cmdList = this.commands.size > 0
            ? Array.from(this.commands.keys()).join(", ")
            : "none";

        // Resolve paths relative to this source file
        const srcDir = dirname(fileURLToPath(import.meta.url));
        const projectDir = resolve(srcDir, "..");
        const pluginsDir = inst?.pluginsDir
            ? resolve(inst.pluginsDir)
            : resolve(projectDir, "plugins");
        const typesPath = resolve(srcDir, "types.ts");
        const readmePath = resolve(projectDir, "README.md");

        const lines = [
            `## Nest Environment`,
            ``,
            `You are running inside nest, an agent gateway.`,
            `Messages arrive from external platforms and responses broadcast to all listeners on your session.`,
            ``,
            `**Instance:** ${name} | **Session:** ${defaultSession}`,
            ``,
        ];

        if (listenerLines.length > 0) {
            lines.push(`### Listeners`, ...listenerLines, ``);
        }

        lines.push(
            `### Plugins`,
            `Loaded: ${pluginList}`,
            ``,
            `### Commands`,
            `${cmdList} (call via nest_command tool)`,
            ``,
            `### Writing Plugins`,
            `- Nest overview & architecture: \`${readmePath}\``,
            `- Plugin API reference (NestAPI, Listener, Middleware, Command): \`${typesPath}\``,
            `- Plugins directory: \`${pluginsDir}/\``,
            `- Each plugin is a subdirectory with \`nest.ts\` (server-side) and/or \`pi.ts\` (agent-side tools)`,
            `- \`nest.ts\` exports a function receiving NestAPI — registers listeners, commands, middleware`,
            `- \`pi.ts\` exports a function receiving ExtensionAPI — registers tools for the agent`,
            `- \`bot!reload\` hot-reloads all nest.ts plugins`,
            `- \`bot!reboot\` restarts the pi session (picks up new/changed pi.ts extensions)`,
        );

        return lines.join("\n");
    }

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

        // Register block protocol endpoints
        if (this.httpServer) {
            this.registerBlockRoutes();
        }

        // Build API and load plugins
        const api = this.buildAPI();
        const pluginsDir = this.config.instance?.pluginsDir ?? "./plugins";
        this.pluginNames = await loadPlugins(pluginsDir, api);
        logger.info("Plugins loaded", { count: this.pluginNames.length, names: this.pluginNames });

        // Register command API (after plugins, so all commands are available)
        if (this.httpServer) {
            this.registerCommandRoutes();
        }

        // Register the context builder before connecting listeners so that
        // any session started by an early incoming message gets the prompt.
        // The builder runs on each session start, so it always reflects
        // current state (listeners, plugins, commands).
        this.sessionManager.setNestContextBuilder(() => this.buildNestContext());

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
        const fileLines = await this.processAttachments(msg.attachments);

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

        // Track the active origin so block protocol uploads and other
        // API-initiated broadcasts can route back to the right channel.
        this.sessionManager.setActiveOrigin(sessionName, origin);
        const activityStart = Date.now();

        try {
            const response = await bridge.sendMessage(promptText, {
                onToolStart: (info) => {
                    const summary = formatToolCall(info);
                    this.sessionManager.broadcast(sessionName, summary, undefined, origin, "tool").catch(() => {});
                },
                onText: (text) => {
                    this.sessionManager.broadcast(sessionName, text, undefined, origin, "stream").catch(() => {});
                },
            });

            if (!response) return;

            // Broadcast final response to all attached listeners
            this.events.emit("message_out", origin, response);
            await this.sessionManager.broadcast(sessionName, response, undefined, origin);
        } catch (err) {
            logger.error("Failed to process message", { error: String(err), session: sessionName });
        } finally {
            this.recordActivity(msg, Date.now() - activityStart);
            clearInterval(typingInterval);
            this.sessionManager.setActiveOrigin(sessionName, null);
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

    private async processAttachments(attachments?: Attachment[]): Promise<string[]> {
        const fileLines: string[] = [];
        if (!attachments?.length) return fileLines;

        cleanupInbox().catch(() => {});

        for (const att of attachments) {
            if (att.data) {
                const saved = await saveToInbox(att.filename, att.data);
                if (saved) fileLines.push(`[Attached file: ${saved} (${att.contentType}, ${att.size} bytes)]`);
            }
        }

        return fileLines;
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

    // ─── Plugin Hot-Reload ─────────────────────────────────

    /**
     * Disconnect all plugin-registered listeners, clear plugin state,
     * reimport plugins, and reconnect. Sessions are stopped and
     * restarted so the new context (listeners, commands) takes effect.
     */
    async reloadPlugins(): Promise<{ loaded: string[]; errors: string[] }> {
        const errors: string[] = [];

        // 1. Stop all sessions (bridges)
        await this.sessionManager.stopAll();

        // 2. Disconnect all listeners
        for (const listener of this.listeners) {
            try { await listener.disconnect(); } catch {}
        }

        // 3. Clear plugin registrations (preserve core commands)
        this.listeners = [];
        this.middlewares = [];
        for (const name of [...this.commands.keys()]) {
            if (!this.coreCommands.has(name)) {
                this.commands.delete(name);
            }
        }

        // 4. Clear plugin routes on HTTP server (preserve kernel routes)
        if (this.httpServer) {
            const keepPaths = new Set([
                "/health", "/api/ping",
                "/api/auth/login", "/api/auth/logout",
                "/api/block", "/api/block/upload", "/api/block/update", "/api/block/remove",
                "/api/block/data/",
                "/api/command", "/api/commands",
            ]);
            this.httpServer.clearPluginRoutes(keepPaths);
        }

        // 5. Reimport plugins with cache-busting
        const pluginsDir = this.config.instance?.pluginsDir ?? "./plugins";
        const api = this.buildAPI();
        this.pluginNames = await loadPlugins(pluginsDir, api, true);
        logger.info("Plugins reloaded", { count: this.pluginNames.length, names: this.pluginNames });

        // 6. Reconnect all listeners
        for (const listener of this.listeners) {
            try {
                listener.onMessage((msg) => this.handleMessage(msg));
                await listener.connect();
            } catch (err) {
                const msg = `Failed to reconnect listener ${listener.name}: ${err}`;
                logger.error(msg);
                errors.push(msg);
            }
        }

        return { loaded: this.pluginNames, errors };
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
