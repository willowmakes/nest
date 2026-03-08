/**
 * Dashboard plugin for nest.
 *
 * Registers API routes for status, sessions, usage, cron, logs, activity.
 * Optionally serves static files from a public directory.
 *
 * Config section:
 *   dashboard:
 *     publicDir: "./public"   # optional, serves frontend SPA
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import type { NestAPI } from "nest";
import { getLogBuffer } from "nest/logger";

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

export default function (nest: NestAPI): void {
    const config = nest.config.dashboard as { publicDir?: string } | undefined;

    // ─── API Routes ──────────────────────────────────────────

    nest.registerRoute("GET", "/api/status", (_req, res) => {
        const sessions = nest.sessions.list();
        const ctx = nest.tracker.currentContext();
        const model = nest.tracker.currentModel();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            ok: true,
            model,
            contextSize: ctx,
            sessions,
        }));
    });

    nest.registerRoute("GET", "/api/sessions", (_req, res) => {
        const names = nest.sessions.list();
        const sessions = names.map((name) => {
            const bridge = nest.sessions.get(name);
            const usage = nest.tracker.todayBySession(name);
            const listeners = nest.sessions.getListeners(name);
            return {
                name,
                state: bridge ? "running" : "idle",
                listeners: listeners.map((b) => ({
                    name: b.listener.name,
                    platform: b.origin.platform,
                    channel: b.origin.channel,
                })),
                today: usage,
            };
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions }));
    });

    nest.registerRoute("GET", "/api/usage", (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const sessionParam = url.searchParams.get("session");

        if (sessionParam) {
            const usage = nest.tracker.todayBySession(sessionParam);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ today: usage, session: sessionParam }));
            return;
        }

        const today = nest.tracker.today();
        const week = nest.tracker.week();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            today,
            week: { cost: week.cost },
            contextSize: nest.tracker.currentContext(),
        }));
    });

    nest.registerRoute("GET", "/api/logs", (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ entries: getLogBuffer() }));
    });

    // ─── Static File Serving ─────────────────────────────────

    const publicDir = config?.publicDir ? resolve(config.publicDir) : null;
    if (publicDir && existsSync(publicDir)) {
        nest.registerPrefixRoute("GET", "/", (req, res) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            let pathname = url.pathname === "/" ? "/index.html" : url.pathname;

            const filePath = resolve(join(publicDir, pathname));
            if (!filePath.startsWith(publicDir)) {
                res.writeHead(403);
                res.end("Forbidden");
                return;
            }

            if (!existsSync(filePath) || !statSync(filePath).isFile()) {
                // SPA fallback
                const indexPath = join(publicDir, "index.html");
                if (existsSync(indexPath)) {
                    res.writeHead(200, { "Content-Type": "text/html" });
                    createReadStream(indexPath).pipe(res);
                    return;
                }
                res.writeHead(404);
                res.end("Not Found");
                return;
            }

            const ext = extname(filePath);
            const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
            res.writeHead(200, { "Content-Type": contentType });
            createReadStream(filePath).pipe(res);
        });

        nest.log.info("Dashboard: serving static files", { publicDir });
    }

    nest.log.info("Dashboard plugin loaded");
}
