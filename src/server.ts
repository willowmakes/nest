import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join, extname, resolve, normalize } from "node:path";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { writeFileSync } from "node:fs";
import yaml from "js-yaml";
import type { ServerConfig, WebhookHandler, ActivityEntry, ExtensionsConfig, ExtensionManifest } from "./types.js";
import type { ConfigWatcher } from "./config-watcher.js";
import type { WorkspaceFiles } from "./vault/files.js";
import { FilePathError, FileNotFoundError } from "./vault/files.js";
import { redactConfig, mergeConfig, serializeConfig, loadConfig } from "./config.js";
import * as logger from "./logger.js";

export interface SessionStateInfo {
    name: string;
    state: string;
    model?: string;
    contextSize?: number;
    lastActivity?: number;
}

export interface DashboardProvider {
    getUptime(): number;
    getStartedAt(): number;
    getModel(): string;
    getContextSize(): number;
    getListenerCount(): number;
    getCronJobs(): Array<{ name: string; schedule: string; enabled: boolean }>;
    getUsage(): {
        today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
        week: { cost: number };
        contextSize: number;
    };
    getActivity(): ActivityEntry[];
    getLogs(): Array<{ timestamp: string; level: string; message: string; [key: string]: unknown }>;
    getSessionNames(): string[];
    getSessionState(name: string): SessionStateInfo | null;
    getUsageBySession(name: string): {
        today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
    } | null;
}

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
};

const WEBHOOK_RATE_WINDOW_MS = 60_000;
const WEBHOOK_RATE_MAX = 10;
const WEBHOOK_GLOBAL_RATE_MAX = 30;
const WEBHOOK_GLOBAL_BUCKET = "__global__";

const AUTH_RATE_WINDOW_MS = 300_000;
const AUTH_RATE_MAX = 5;

const MAX_BODY_SIZE = 1_048_576; // 1MB

const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_MAX = 120;

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type WsRpcHandler = (message: { type: string; [key: string]: unknown }, clientId: string) => Promise<any>;

export class HttpServer {
    private server: Server;
    private config: ServerConfig;
    private publicDir: string;
    private startTime: number;
    private routes = new Map<string, Map<string, RouteHandler>>();
    private webhookHandler?: WebhookHandler;
    private configWatcher?: ConfigWatcher;
    private configPath?: string;
    private webhookRateLimits = new Map<string, number[]>();
    private authRateLimits = new Map<string, number[]>();
    private dashboard: DashboardProvider | null;
    private wss: WebSocketServer;
    private wsClients = new Map<string, WebSocket>();
    private wsClientCounter = 0;
    private wsRateLimits = new Map<string, number[]>();
    private wsHandler?: WsRpcHandler;
    private workspaceFiles?: WorkspaceFiles;
    private extensionsConfig?: ExtensionsConfig;
    private prefixRoutes: Array<{ prefix: string; method: string; handler: RouteHandler }> = [];
    private sessions = new Map<string, { createdAt: number }>();

    constructor(config: ServerConfig, dashboard?: DashboardProvider) {
        this.config = config;
        this.dashboard = dashboard ?? null;
        this.publicDir = config.publicDir
            ? resolve(config.publicDir)
            : resolve("public");
        this.startTime = Date.now();

        this.server = createServer((req, res) => this.handleRequest(req, res));
        this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
        this.wss = new WebSocketServer({ noServer: true });

        this.registerRoutes();
    }

    /** Expose the underlying http.Server for testing */
    get raw(): Server {
        return this.server;
    }

    /** Number of connected WebSocket clients */
    get wsClientCount(): number {
        return this.wsClients.size;
    }

    /** Set the handler for incoming WebSocket RPC commands */
    setWsHandler(handler: WsRpcHandler): void {
        this.wsHandler = handler;
    }

    /** Broadcast a bridge event to all connected WebSocket clients */
    broadcastEvent(event: any): void {
        if (this.wsClients.size === 0) return;
        const data = JSON.stringify(event);
        for (const [, client] of this.wsClients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }

    /** Send an event to a specific WebSocket client by ID */
    sendToClient(clientId: string, event: any): void {
        const client = this.wsClients.get(clientId);
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(event));
        }
    }

    async start(): Promise<void> {
        const host = this.config.host ?? "127.0.0.1";
        return new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.config.port, host, () => {
                this.server.removeListener("error", reject);
                logger.info("HTTP server listening", { port: this.config.port, host });
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        // Close all WebSocket connections first
        for (const [, client] of this.wsClients) {
            client.close(1001, "Server shutting down");
        }
        this.wsClients.clear();

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.server.closeAllConnections();
            }, 5000);
            this.server.close(() => {
                clearTimeout(timeout);
                logger.info("HTTP server stopped");
                resolve();
            });
            this.server.closeIdleConnections();
        });
    }

    setWebhookHandler(handler: WebhookHandler): void {
        this.webhookHandler = handler;
    }

    setConfigWatcher(watcher: ConfigWatcher, configPath: string): void {
        this.configWatcher = watcher;
        this.configPath = configPath;
    }

    setFiles(files: WorkspaceFiles): void {
        this.workspaceFiles = files;
        this.registerFileRoutes();
    }

    setExtensions(config: ExtensionsConfig): void {
        this.extensionsConfig = config;
        this.registerExtensionRoutes();
    }

    private registerExtensionRoutes(): void {
        const extDir = this.extensionsConfig!.dir;

        // GET /api/extensions — list all extensions
        this.route("GET", "/api/extensions", async (_req, res) => {
            const dir = resolve(extDir);
            if (!existsSync(dir) || !statSync(dir).isDirectory()) {
                this.json(res, 200, { extensions: [] });
                return;
            }

            const extensions: ExtensionManifest[] = [];
            try {
                const entries = readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const manifestPath = join(dir, entry.name, "manifest.yaml");
                    if (!existsSync(manifestPath)) continue;
                    try {
                        const raw = readFileSync(manifestPath, "utf-8");
                        const manifest = yaml.load(raw) as ExtensionManifest;
                        if (manifest && manifest.id && manifest.name && manifest.entry) {
                            extensions.push({
                                id: manifest.id,
                                name: manifest.name,
                                version: manifest.version ?? 1,
                                entry: manifest.entry,
                                ...(manifest.styles ? { styles: manifest.styles } : {}),
                            });
                        }
                    } catch {
                        // Skip extensions with invalid manifests
                    }
                }
            } catch (err) {
                logger.error("Failed to scan extensions directory", { error: String(err) });
            }

            this.json(res, 200, { extensions });
        });

        // GET /api/extensions/:id/* — serve extension files
        this.prefixRoute("GET", "/api/extensions/", async (req, res) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            const prefix = "/api/extensions/";
            const rest = decodeURIComponent(url.pathname.slice(prefix.length));
            if (!rest) {
                // This is the list endpoint, already handled by exact route
                this.json(res, 404, { error: "Not Found" });
                return;
            }

            const slashIdx = rest.indexOf("/");
            if (slashIdx === -1) {
                this.json(res, 400, { error: "Missing file path" });
                return;
            }

            const extId = rest.slice(0, slashIdx);
            const filePath = rest.slice(slashIdx + 1);

            if (!extId || !filePath) {
                this.json(res, 400, { error: "Missing extension ID or file path" });
                return;
            }

            // Validate extension ID: alphanumeric, hyphens, underscores only (C1/C2)
            if (!/^[a-zA-Z0-9_-]+$/.test(extId)) {
                this.json(res, 400, { error: "Invalid extension ID" });
                return;
            }

            // Prevent directory traversal via extension ID
            const resolvedExtDir = resolve(extDir);
            const extRoot = resolve(resolvedExtDir, extId);
            if (!extRoot.startsWith(resolvedExtDir + "/")) {
                this.json(res, 403, { error: "Forbidden" });
                return;
            }

            // Prevent directory traversal via file path
            const fullPath = resolve(extRoot, normalize(filePath));
            if (!fullPath.startsWith(extRoot + "/") && fullPath !== extRoot) {
                this.json(res, 403, { error: "Forbidden" });
                return;
            }

            if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
                this.json(res, 404, { error: "Not Found" });
                return;
            }

            const ext = extname(fullPath);
            const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

            res.writeHead(200, { "Content-Type": contentType });
            createReadStream(fullPath).pipe(res);
        });
    }

    private prefixRoute(method: string, prefix: string, handler: RouteHandler): void {
        this.prefixRoutes.push({ prefix, method, handler });
    }

    private registerFileRoutes(): void {
        // List configured roots
        this.route("GET", "/api/roots", async (_req, res) => {
            const roots = this.workspaceFiles!.getRootNames();
            this.json(res, 200, { roots });
        });

        // List files — requires ?root=name
        this.route("GET", "/api/files", async (req, res) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            const root = url.searchParams.get("root");
            const dir = url.searchParams.get("dir") ?? undefined;
            const search = url.searchParams.get("search") ?? undefined;

            if (!root) {
                this.json(res, 400, { error: "Missing required 'root' parameter" });
                return;
            }

            try {
                const entries = await this.workspaceFiles!.listFiles(root, dir, search);
                this.json(res, 200, { entries });
            } catch (err) {
                this.handleFileError(res, err);
            }
        });

        // Move file — requires root in body
        this.route("POST", "/api/files/move", async (req, res) => {
            let body: any;
            try {
                body = await this.readJsonBody(req);
            } catch (err) {
                this.handleBodyError(req, res, err);
                return;
            }

            if (!body || typeof body.root !== "string" || typeof body.from !== "string" || typeof body.to !== "string") {
                this.json(res, 400, { error: "Body must include 'root', 'from', and 'to' strings" });
                return;
            }

            if (!body.from.trim() || !body.to.trim()) {
                this.json(res, 400, { error: "Paths cannot be empty" });
                return;
            }

            try {
                await this.workspaceFiles!.moveFile(body.root, body.from, body.to);
                this.json(res, 200, { ok: true, from: body.from, to: body.to });
            } catch (err) {
                this.handleFileError(res, err);
            }
        });

        // Read file: /api/files/:root/:path...
        this.prefixRoute("GET", "/api/files/", async (req, res) => {
            const parsed = this.extractRootAndPath(req.url ?? "");
            if (!parsed) {
                this.json(res, 400, { error: "Missing root and file path" });
                return;
            }
            const { root, filePath } = parsed;

            const url = new URL(req.url ?? "/", "http://localhost");
            if (url.searchParams.get("raw") === "true") {
                try {
                    const result = await this.workspaceFiles!.readFileRaw(root, filePath);
                    const headers: Record<string, string | number> = {
                        "Content-Type": result.mimeType,
                        "Content-Length": result.buffer.length,
                        "X-Content-Type-Options": "nosniff",
                    };
                    if (result.mimeType === "image/svg+xml") {
                        headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'";
                    }
                    res.writeHead(200, headers);
                    res.end(result.buffer);
                } catch (err) {
                    this.handleFileError(res, err);
                }
                return;
            }

            try {
                const result = await this.workspaceFiles!.readFile(root, filePath);
                this.json(res, 200, result);
            } catch (err) {
                this.handleFileError(res, err);
            }
        });

        // Write file: /api/files/:root/:path...
        this.prefixRoute("PUT", "/api/files/", async (req, res) => {
            const parsed = this.extractRootAndPath(req.url ?? "");
            if (!parsed) {
                this.json(res, 400, { error: "Missing root and file path" });
                return;
            }
            const { root, filePath } = parsed;

            let body: any;
            try {
                body = await this.readJsonBody(req);
            } catch (err) {
                this.handleBodyError(req, res, err);
                return;
            }

            if (!body || typeof body.content !== "string") {
                this.json(res, 400, { error: "Body must include 'content' string" });
                return;
            }

            try {
                await this.workspaceFiles!.writeFile(root, filePath, body.content);
                this.json(res, 200, { ok: true, path: filePath });
            } catch (err) {
                this.handleFileError(res, err);
            }
        });

        // Delete file: /api/files/:root/:path...
        this.prefixRoute("DELETE", "/api/files/", async (req, res) => {
            const parsed = this.extractRootAndPath(req.url ?? "");
            if (!parsed) {
                this.json(res, 400, { error: "Missing root and file path" });
                return;
            }
            const { root, filePath } = parsed;

            try {
                await this.workspaceFiles!.deleteFile(root, filePath);
                this.json(res, 200, { ok: true, path: filePath });
            } catch (err) {
                this.handleFileError(res, err);
            }
        });
    }

    /** Extract root name and file path from /api/files/:root/:path... */
    private extractRootAndPath(rawUrl: string): { root: string; filePath: string } | null {
        const url = new URL(rawUrl, "http://localhost");
        const prefix = "/api/files/";
        if (!url.pathname.startsWith(prefix)) return null;
        const rest = decodeURIComponent(url.pathname.slice(prefix.length));
        if (!rest) return null;
        const slashIdx = rest.indexOf("/");
        if (slashIdx === -1) return null;
        const root = rest.slice(0, slashIdx);
        const filePath = rest.slice(slashIdx + 1);
        if (!root || !filePath) return null;
        return { root, filePath };
    }

    private handleFileError(res: ServerResponse, err: unknown): void {
        if (err instanceof FilePathError) {
            const status = err.message.includes("is a directory") ? 400 : 403;
            this.json(res, status, { error: err.message });
        } else if (err instanceof FileNotFoundError) {
            this.json(res, 404, { error: err.message });
        } else {
            logger.error("File error", { error: String(err) });
            this.json(res, 500, { error: "Internal server error" });
        }
    }

    private registerRoutes(): void {
        this.route("GET", "/api/ping", (_req, res) => {
            this.json(res, 200, { pong: true });
        });

        // ─── Auth Endpoints ────────────────────────────────────────

        this.route("POST", "/api/auth/login", async (req, res) => {
            let body: any;
            try {
                body = await this.readJsonBody(req);
            } catch (err) {
                this.handleBodyError(req, res, err);
                return;
            }

            if (!body || typeof body.token !== "string") {
                this.json(res, 400, { error: "Missing required field: token" });
                return;
            }

            // Validate token using timing-safe comparison
            const provided = Buffer.from(body.token);
            const expected = Buffer.from(this.config.token);

            let valid = false;
            if (provided.length !== expected.length) {
                const dummy = Buffer.alloc(expected.length);
                timingSafeEqual(expected, dummy);
            } else {
                valid = timingSafeEqual(provided, expected);
            }

            if (!valid) {
                const clientIp = this.getClientIp(req);
                this.recordAuthFailure(clientIp);
                this.json(res, 401, { error: "Unauthorized" });
                return;
            }

            // Clean up expired sessions on login
            const now = Date.now();
            for (const [id, session] of this.sessions) {
                if (now - session.createdAt >= SESSION_MAX_AGE_MS) {
                    this.sessions.delete(id);
                }
            }

            const sessionId = randomBytes(32).toString("hex");
            this.sessions.set(sessionId, { createdAt: now });

            const secure = this.config.trustProxy ? "; Secure" : "";
            res.setHeader("Set-Cookie",
                `nest-session=${sessionId}; HttpOnly; SameSite=Strict; Path=/${secure}`);
            this.json(res, 200, { ok: true });
        });

        this.route("POST", "/api/auth/logout", async (req, res) => {
            const sessionId = this.parseCookie(req);
            if (sessionId) {
                this.sessions.delete(sessionId);
            }

            const secure = this.config.trustProxy ? "; Secure" : "";
            res.setHeader("Set-Cookie",
                `nest-session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
            this.json(res, 200, { ok: true });
        });

        this.route("GET", "/api/status", (_req, res) => {
            if (this.dashboard) {
                this.json(res, 200, {
                    ok: true,
                    uptime: Math.floor(this.dashboard.getUptime() / 1000),
                    startedAt: new Date(this.dashboard.getStartedAt()).toISOString(),
                    model: this.dashboard.getModel(),
                    contextSize: this.dashboard.getContextSize(),
                    listenerCount: this.dashboard.getListenerCount(),
                    sessions: this.dashboard.getSessionNames(),
                });
            } else {
                this.json(res, 200, {
                    ok: true,
                    uptime: Math.floor((Date.now() - this.startTime) / 1000),
                    startedAt: new Date(this.startTime).toISOString(),
                });
            }
        });

        this.route("GET", "/api/sessions", (_req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, { sessions: [] });
                return;
            }
            const names = this.dashboard.getSessionNames();
            const sessions = names.map((name) => {
                try {
                    const state = this.dashboard!.getSessionState(name);
                    const usage = this.dashboard!.getUsageBySession(name);
                    return {
                        name,
                        state: state?.state ?? "unknown",
                        model: state?.model,
                        contextSize: state?.contextSize,
                        lastActivity: state?.lastActivity,
                        today: usage?.today ?? null,
                    };
                } catch (err) {
                    logger.warn("Failed to get session info", { name, error: String(err) });
                    return { name, state: "error", model: null, contextSize: null, lastActivity: null, today: null };
                }
            });
            this.json(res, 200, { sessions });
        });

        this.route("GET", "/api/cron", (_req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, { jobs: [] });
                return;
            }
            this.json(res, 200, { jobs: this.dashboard.getCronJobs() });
        });

        this.route("GET", "/api/usage", (req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, {
                    today: { inputTokens: 0, outputTokens: 0, cost: 0, messageCount: 0 },
                    week: { cost: 0 },
                    contextSize: 0,
                });
                return;
            }

            // Support ?session=<name> for per-session usage
            const url = new URL(req.url ?? "/", "http://localhost");
            const sessionParam = url.searchParams.get("session");
            if (sessionParam && this.dashboard.getUsageBySession) {
                const sessionUsage = this.dashboard.getUsageBySession(sessionParam);
                if (!sessionUsage) {
                    this.json(res, 404, { error: `Unknown session: ${sessionParam}` });
                    return;
                }
                this.json(res, 200, { today: sessionUsage.today, session: sessionParam });
                return;
            }

            this.json(res, 200, this.dashboard.getUsage());
        });

        this.route("GET", "/api/activity", (_req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, { entries: [] });
                return;
            }
            this.json(res, 200, { entries: this.dashboard.getActivity() });
        });

        this.route("GET", "/api/logs", (_req, res) => {
            if (!this.dashboard) {
                this.json(res, 200, { entries: [] });
                return;
            }
            this.json(res, 200, { entries: this.dashboard.getLogs() });
        });

        // ─── Config API ────────────────────────────────────────────

        this.route("GET", "/api/config", (_req, res) => {
            if (!this.configWatcher) {
                this.json(res, 503, { error: "Config watcher not configured" });
                return;
            }
            const config = this.configWatcher.getCurrentConfig();
            this.json(res, 200, redactConfig(config));
        });

        this.route("POST", "/api/config", async (req, res) => {
            if (!this.configWatcher || !this.configPath) {
                this.json(res, 503, { error: "Config watcher not configured" });
                return;
            }

            let body: Record<string, unknown>;
            try {
                body = await this.readJsonBody(req);
            } catch (err) {
                this.handleBodyError(req, res, err);
                return;
            }

            if (!body || typeof body !== "object" || Array.isArray(body)) {
                this.json(res, 400, { error: "Body must be a JSON object" });
                return;
            }

            // Enforce config allowlist — immutable sections cannot be modified via API
            const immutableSections = new Set(["server", "security", "token", "files"]);
            for (const key of Object.keys(body)) {
                if (immutableSections.has(key)) {
                    this.json(res, 403, { error: `Cannot modify ${key} via API` });
                    return;
                }
            }

            try {
                const current = this.configWatcher.getCurrentConfig();
                const merged = mergeConfig(current, body);

                // Validate by round-tripping through loadConfig-style validation
                // Write to file first, then let the watcher pick up the change
                const yamlStr = serializeConfig(merged);
                writeFileSync(this.configPath, yamlStr, "utf-8");

                // Validate the written file can be loaded (catches env var issues etc.)
                loadConfig(this.configPath);

                logger.info("Config updated via API", { sections: Object.keys(body) });
                this.json(res, 200, { ok: true, config: redactConfig(merged) });
            } catch (err) {
                logger.error("Config API update failed", { error: String(err) });
                this.json(res, 400, { error: "Invalid config format. Check server logs for details." });
            }
        });

        this.route("POST", "/api/webhook", async (req, res) => {
            if (!this.webhookHandler) {
                this.json(res, 503, { error: "Webhook handler not configured" });
                return;
            }

            let body: any;
            try {
                body = await this.readJsonBody(req);
            } catch (err) {
                this.handleBodyError(req, res, err);
                return;
            }

            if (!body || typeof body.message !== "string" || !body.message.trim()) {
                this.json(res, 400, { error: "Missing required field: message" });
                return;
            }

            // Validate session exists BEFORE rate limiting so invalid
            // sessions don't consume rate limit quota
            if (body.session && typeof body.session === "string" && this.dashboard) {
                const validSessions = this.dashboard.getSessionNames();
                if (!validSessions.includes(body.session)) {
                    this.json(res, 400, { error: `Unknown session: ${body.session}` });
                    return;
                }
            }

            // Global rate limit first (prevents bypass via many source values)
            if (this.isWebhookRateLimited(WEBHOOK_GLOBAL_BUCKET, WEBHOOK_GLOBAL_RATE_MAX)) {
                this.json(res, 429, { error: "Rate limit exceeded" });
                return;
            }

            // Per-source rate limit
            const rateBucket = body.source ?? "webhook";
            if (this.isWebhookRateLimited(rateBucket, WEBHOOK_RATE_MAX)) {
                this.json(res, 429, { error: "Rate limit exceeded" });
                return;
            }

            try {
                const result = await this.webhookHandler({
                    message: body.message,
                    notify: body.notify,
                    source: body.source,
                    session: body.session,
                });

                const status = result.queued ? 202 : 200;
                this.json(res, status, result);
            } catch (err) {
                logger.error("Webhook handler error", { error: String(err) });
                this.json(res, 500, { error: "Internal server error" });
            }
        });
    }

    private route(method: string, path: string, handler: RouteHandler): void {
        if (!this.routes.has(path)) {
            this.routes.set(path, new Map());
        }
        this.routes.get(path)!.set(method, handler);
    }

    /** Extract real client IP, respecting reverse proxy headers only when trustProxy is enabled */
    private getClientIp(req: IncomingMessage): string {
        if (this.config.trustProxy) {
            // X-Forwarded-For: leftmost entry is the original client
            const xff = req.headers["x-forwarded-for"];
            if (xff) {
                const first = (Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
                if (first) return first;
            }
            // X-Real-IP: single IP set by some proxies (e.g. nginx)
            const xri = req.headers["x-real-ip"];
            if (xri) {
                const ip = Array.isArray(xri) ? xri[0] : xri;
                if (ip) return ip;
            }
        }
        return req.socket.remoteAddress ?? "unknown";
    }

    private setSecurityHeaders(res: ServerResponse): void {
        res.setHeader("Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; connect-src 'self'");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    }

    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const startTime = Date.now();
        let authResult: 'ok' | 'failed' | 'none' = 'none';

        this.setSecurityHeaders(res);

        const url = new URL(req.url ?? "/", `http://localhost`);
        const pathname = url.pathname;

        // Set up access logging for API routes (fires after response is sent)
        if (pathname.startsWith("/api/") || pathname === "/attach") {
            res.on('finish', () => {
                this.logAccess(req, res, authResult, startTime);
            });
        }

        // Health endpoint — no auth required
        if (pathname === "/health" && (req.method ?? "GET") === "GET") {
            this.json(res, 200, { status: "ok" });
            return;
        }

        // CORS preflight — no auth required
        if (req.method === "OPTIONS" && this.config.cors) {
            this.setCorsHeaders(res);
            res.writeHead(204);
            res.end();
            return;
        }

        // Per-IP rate limiting on auth failures
        const clientIp = this.getClientIp(req);
        if (this.isAuthRateLimited(clientIp)) {
            this.json(res, 429, { error: "Too many failed auth attempts. Try again later." });
            return;
        }

        // API and attach routes require auth (except login endpoint)
        if ((pathname.startsWith("/api/") || pathname === "/attach") && pathname !== "/api/auth/login") {
            if (!this.authenticate(req)) {
                authResult = 'failed';
                this.recordAuthFailure(clientIp);
                // Exponential backoff after 3 failures in current window
                const failures = this.getAuthFailureCount(clientIp);
                if (failures > 3) {
                    await new Promise(r => setTimeout(r, Math.min(2 ** (failures - 3) * 1000, 30_000)));
                }
                this.json(res, 401, { error: "Unauthorized" });
                return;
            }
            authResult = 'ok';
        }

        // Set CORS headers on all responses if configured
        if (this.config.cors) {
            this.setCorsHeaders(res);
        }

        // Check registered routes (exact match)
        const methods = this.routes.get(pathname);
        if (methods) {
            const handler = methods.get(req.method ?? "GET");
            if (handler) {
                try {
                    const result = handler(req, res);
                    if (result instanceof Promise) {
                        await result;
                    }
                } catch (err) {
                    logger.error("Route handler error", { path: pathname, error: String(err) });
                    if (!res.headersSent) {
                        this.json(res, 500, { error: "Internal server error" });
                    }
                }
                return;
            }
            // Path exists but wrong method
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method Not Allowed" }));
            return;
        }

        // Check prefix routes (wildcard path matching)
        for (const route of this.prefixRoutes) {
            if (pathname.startsWith(route.prefix) && (req.method ?? "GET") === route.method) {
                try {
                    const result = route.handler(req, res);
                    if (result instanceof Promise) {
                        await result;
                    }
                } catch (err) {
                    logger.error("Route handler error", { path: pathname, error: String(err) });
                    if (!res.headersSent) {
                        this.json(res, 500, { error: "Internal server error" });
                    }
                }
                return;
            }
        }

        // Static file serving for non-API paths
        if (!pathname.startsWith("/api/") && pathname !== "/attach") {
            this.serveStatic(pathname, res);
            return;
        }

        this.json(res, 404, { error: "Not Found" });
    }

    private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
        const url = new URL(req.url ?? "/", `http://localhost`);

        if (url.pathname !== "/attach") {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        // Authenticate via session cookie or Authorization header
        const preAuth = this.authenticate(req);

        this.wss.handleUpgrade(req, socket, head, (ws) => {
            const clientId = `ws-${++this.wsClientCounter}`;
            let authenticated = preAuth;

            // Keep-alive: ping every 30s so proxies/NAT don't drop idle connections.
            // The ws package handles pong responses automatically.
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.ping();
            }, 30_000);

            // If not pre-authenticated via header, require first-message auth within 5s
            let authTimeout: ReturnType<typeof setTimeout> | undefined;
            if (!authenticated) {
                authTimeout = setTimeout(() => {
                    if (!authenticated) {
                        this.wsSend(ws, { type: "error", error: "Auth timeout" });
                        ws.close(4001, "Auth timeout");
                    }
                }, 5000);
            } else {
                // Already authenticated via header — add to clients immediately
                this.wsClients.set(clientId, ws);
                this.wsSend(ws, { type: "auth_ok" });
                logger.info("WebSocket client connected at /attach (pre-authenticated)", { clientId });
            }

            ws.on("message", async (rawData) => {
                let msg: any;
                try {
                    msg = JSON.parse(rawData.toString());
                } catch {
                    this.wsSend(ws, { type: "error", error: "Invalid JSON" });
                    return;
                }

                // Handle first-message auth for browser clients
                if (!authenticated) {
                    if (msg.type === "auth" && typeof msg.token === "string") {
                        const provided = Buffer.from(msg.token);
                        const expected = Buffer.from(this.config.token);
                        let valid = false;
                        if (provided.length === expected.length) {
                            valid = timingSafeEqual(provided, expected);
                        } else {
                            const dummy = Buffer.alloc(expected.length);
                            timingSafeEqual(expected, dummy);
                        }
                        if (valid) {
                            authenticated = true;
                            if (authTimeout) clearTimeout(authTimeout);
                            this.wsClients.set(clientId, ws);
                            this.wsSend(ws, { type: "auth_ok" });
                            logger.info("WebSocket client connected at /attach (message auth)", { clientId });
                            return;
                        }
                    }
                    // Auth failed
                    if (authTimeout) clearTimeout(authTimeout);
                    this.wsSend(ws, { type: "error", error: "Unauthorized" });
                    ws.close(4003, "Unauthorized");
                    return;
                }

                // Per-client message rate limiting
                if (this.isWsRateLimited(clientId)) {
                    this.wsSend(ws, { type: "error", error: "Rate limit exceeded" });
                    ws.close(4008, "Rate limit exceeded");
                    return;
                }

                if (!msg.type) {
                    this.wsSend(ws, { id: msg.id, type: "response", success: false, error: "Missing type" });
                    return;
                }

                if (!this.wsHandler) {
                    this.wsSend(ws, { id: msg.id, type: "response", success: false, error: "No handler configured" });
                    return;
                }

                try {
                    const { id, type, ...params } = msg;
                    const result = await this.wsHandler({ type, ...params }, clientId);
                    this.wsSend(ws, { id, type: "response", success: true, data: result });
                } catch (err) {
                    this.wsSend(ws, { id: msg.id, type: "response", success: false, error: String(err) });
                }
            });

            ws.on("close", () => {
                clearInterval(pingInterval);
                if (authTimeout) clearTimeout(authTimeout);
                this.wsClients.delete(clientId);
                this.wsRateLimits.delete(clientId);
                logger.info("WebSocket client disconnected", { clientId });
            });

            ws.on("error", (err) => {
                clearInterval(pingInterval);
                if (authTimeout) clearTimeout(authTimeout);
                logger.error("WebSocket client error", { error: String(err), clientId });
                this.wsClients.delete(clientId);
                this.wsRateLimits.delete(clientId);
            });
        });
    }

    /** Send JSON to a WebSocket client if still open */
    private wsSend(ws: WebSocket, data: any): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    private authenticate(req: IncomingMessage): boolean {
        // Check session cookie first (browser clients)
        const sessionId = this.parseCookie(req);
        if (sessionId) {
            const session = this.sessions.get(sessionId);
            if (session) {
                if (Date.now() - session.createdAt < SESSION_MAX_AGE_MS) {
                    return true;
                }
                // Session expired — remove it
                this.sessions.delete(sessionId);
            }
        }

        // Fall back to Bearer token (TUI/programmatic clients)
        const auth = req.headers["authorization"];
        if (!auth) return false;

        const parts = auth.split(" ");
        if (parts.length !== 2 || parts[0] !== "Bearer") return false;

        const provided = Buffer.from(parts[1]);
        const expected = Buffer.from(this.config.token);

        // Avoid length-based timing leak: compare expected against a zero-filled
        // buffer so attacker can't learn expected content from the comparison.
        if (provided.length !== expected.length) {
            const dummy = Buffer.alloc(expected.length);
            timingSafeEqual(expected, dummy);
            return false;
        }

        return timingSafeEqual(provided, expected);
    }

    private parseCookie(req: IncomingMessage): string | null {
        const cookie = req.headers.cookie;
        if (!cookie) return null;
        const match = cookie.match(/(?:^|;\s*)nest-session=([^\s;]+)/);
        return match ? match[1] : null;
    }

    private serveStatic(pathname: string, res: ServerResponse): void {
        // Default to index.html for root
        const filePath = pathname === "/"
            ? join(this.publicDir, "index.html")
            : join(this.publicDir, pathname);

        // Prevent directory traversal
        const resolved = resolve(filePath);
        if (!resolved.startsWith(this.publicDir)) {
            this.json(res, 403, { error: "Forbidden" });
            return;
        }

        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
            this.json(res, 404, { error: "Not Found" });
            return;
        }

        const ext = extname(resolved);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

        res.writeHead(200, { "Content-Type": contentType });
        createReadStream(resolved).pipe(res);
    }

    private handleBodyError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Payload Too Large") {
            this.json(res, 413, { error: "Payload Too Large" });
        } else if (msg === "Unsupported Media Type") {
            this.json(res, 415, { error: "Unsupported Media Type" });
        } else {
            this.json(res, 400, { error: "Invalid JSON body" });
        }
        // Destroy request after sending response to stop data flow
        req.destroy();
    }

    private readJsonBody(req: IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            // Validate Content-Type if present — caller destroys req after sending response
            const contentType = req.headers["content-type"];
            if (contentType && !contentType.startsWith("application/json")) {
                reject(new Error("Unsupported Media Type"));
                return;
            }

            let size = 0;
            let data = "";
            let destroyed = false;
            req.on("data", (chunk: Buffer) => {
                if (destroyed) return;
                size += chunk.length;
                if (size > MAX_BODY_SIZE) {
                    destroyed = true;
                    reject(new Error("Payload Too Large"));
                    return;
                }
                data += chunk.toString();
            });
            req.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error("Invalid JSON"));
                }
            });
            req.on("error", reject);
        });
    }

    private isWebhookRateLimited(bucket: string, max: number): boolean {
        const now = Date.now();
        const timestamps = this.webhookRateLimits.get(bucket) ?? [];
        const recent = timestamps.filter((t) => now - t < WEBHOOK_RATE_WINDOW_MS);

        if (recent.length === 0) {
            this.webhookRateLimits.delete(bucket);
            // Still need to record this request
            this.webhookRateLimits.set(bucket, [now]);
            return false;
        }

        if (recent.length >= max) {
            this.webhookRateLimits.set(bucket, recent);
            return true;
        }

        recent.push(now);
        this.webhookRateLimits.set(bucket, recent);
        return false;
    }

    private isWsRateLimited(clientId: string): boolean {
        const now = Date.now();
        const timestamps = this.wsRateLimits.get(clientId) ?? [];
        const recent = timestamps.filter((t) => now - t < WS_RATE_WINDOW_MS);
        recent.push(now);
        this.wsRateLimits.set(clientId, recent);
        return recent.length > WS_RATE_MAX;
    }

    private recordAuthFailure(ip: string): void {
        const now = Date.now();
        const timestamps = this.authRateLimits.get(ip) ?? [];
        timestamps.push(now);
        this.authRateLimits.set(ip, timestamps);
    }

    private isAuthRateLimited(ip: string): boolean {
        const timestamps = this.authRateLimits.get(ip);
        if (!timestamps) return false;
        const now = Date.now();
        const recent = timestamps.filter((t) => now - t < AUTH_RATE_WINDOW_MS);

        if (recent.length === 0) {
            this.authRateLimits.delete(ip);
            return false;
        }

        this.authRateLimits.set(ip, recent);
        return recent.length >= AUTH_RATE_MAX;
    }

    private getAuthFailureCount(ip: string): number {
        const timestamps = this.authRateLimits.get(ip);
        if (!timestamps) return 0;
        const now = Date.now();
        return timestamps.filter(t => now - t < AUTH_RATE_WINDOW_MS).length;
    }

    private setCorsHeaders(res: ServerResponse): void {
        if (!this.config.cors) return;
        res.setHeader("Access-Control-Allow-Origin", this.config.cors.origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    private logAccess(req: IncomingMessage, res: ServerResponse, authResult: 'ok' | 'failed' | 'none', startTime: number): void {
        const durationMs = Date.now() - startTime;
        const ip = this.getClientIp(req);
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        const status = res.statusCode;

        logger.info("access", { ip, method, path, status, auth: authResult, durationMs });

        if (authResult === "failed") {
            logger.warn("auth_failed", { ip, method, path, reason: "invalid credentials" });
        }
    }

    private json(res: ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
    }
}
