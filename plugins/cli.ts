/**
 * CLI listener plugin for nest.
 *
 * Exposes a WebSocket endpoint at /cli that `nest attach` connects to.
 * Messages from the CLI go through the same kernel pipeline as Discord.
 *
 * Protocol (client → server):
 *   { type: "auth", token: "..." }           — authenticate
 *   { type: "message", text: "hello" }       — send a message
 *
 * Protocol (server → client):
 *   { type: "auth_ok" }                      — authenticated
 *   { type: "auth_fail" }                    — bad token
 *   { type: "text", text: "..." }            — response/streaming text
 *   { type: "tool_start", tool: "bash", ... }— tool call started
 *   { type: "files", files: [...] }          — outgoing files
 *   { type: "typing" }                       — typing indicator
 *   { type: "error", text: "..." }           — error
 *   { type: "system", text: "..." }          — system message
 */
import { WebSocketServer, WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import type { NestAPI, Listener, IncomingMessage, MessageOrigin, OutgoingFile } from "../src/types.js";

interface CliClient {
    ws: WebSocket;
    id: string;
    authenticated: boolean;
    username: string;
}

class CliListener implements Listener {
    readonly name = "cli";
    private wss: WebSocketServer;
    private clients = new Map<string, CliClient>();
    private clientCounter = 0;
    private messageHandler?: (msg: IncomingMessage) => void;
    private token: string;
    private nest: NestAPI;

    constructor(nest: NestAPI, token: string) {
        this.nest = nest;
        this.token = token;
        this.wss = new WebSocketServer({ noServer: true });
    }

    async connect(): Promise<void> {
        // Nothing to do — connections come via handleUpgrade
    }

    async disconnect(): Promise<void> {
        for (const [, client] of this.clients) {
            client.ws.close(1001, "Shutting down");
        }
        this.clients.clear();
        this.wss.close();
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler;
    }

    async send(origin: MessageOrigin, text: string, files?: OutgoingFile[], kind?: "text" | "tool" | "stream"): Promise<void> {
        const client = this.clients.get(origin.channel);
        if (!client || client.ws.readyState !== WebSocket.OPEN) return;

        if (text) {
            const type = kind === "tool" ? "tool_start" : kind === "stream" ? "stream" : "text";
            this.wsSend(client.ws, { type, text });
        }
        if (files?.length) {
            this.wsSend(client.ws, {
                type: "files",
                files: files.map((f) => ({ filename: f.filename, size: f.data.length })),
            });
        }
    }

    async sendTyping(origin: MessageOrigin): Promise<void> {
        const client = this.clients.get(origin.channel);
        if (!client || client.ws.readyState !== WebSocket.OPEN) return;
        this.wsSend(client.ws, { type: "typing" });
    }

    notifyOrigin(): MessageOrigin | null {
        // Cron output doesn't go to CLI
        return null;
    }

    /** Called by the HTTP server upgrade handler */
    handleUpgrade(req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
            const clientId = `cli-${++this.clientCounter}`;
            const client: CliClient = { ws, id: clientId, authenticated: false, username: "cli" };
            this.nest.log.info("CLI client connected", { clientId });

            const authTimeout = setTimeout(() => {
                if (!client.authenticated) {
                    ws.close(4001, "Auth timeout");
                }
            }, 5000);

            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.ping();
            }, 30_000);

            ws.on("message", (rawData) => {
                let msg: any;
                try {
                    msg = JSON.parse(rawData.toString());
                } catch {
                    this.wsSend(ws, { type: "error", text: "Invalid JSON" });
                    return;
                }

                if (!client.authenticated) {
                    if (msg.type === "auth" && this.validateToken(msg.token)) {
                        client.authenticated = true;
                        client.username = msg.username ?? "cli";
                        clearTimeout(authTimeout);
                        this.clients.set(clientId, client);
                        this.wsSend(ws, { type: "auth_ok", clientId });
                        this.wsSend(ws, { type: "system", text: `Connected to nest as "${client.username}"` });
                    } else {
                        clearTimeout(authTimeout);
                        this.wsSend(ws, { type: "auth_fail" });
                        ws.close(4003, "Unauthorized");
                    }
                    return;
                }

                if (msg.type === "message" && typeof msg.text === "string" && msg.text.trim()) {
                    this.messageHandler?.({
                        platform: "cli",
                        channel: clientId,
                        sender: client.username,
                        text: msg.text.trim(),
                    });
                }
            });

            ws.on("close", () => {
                clearTimeout(authTimeout);
                clearInterval(pingInterval);
                this.clients.delete(clientId);
                this.nest.log.info("CLI client disconnected", { clientId });
            });

            ws.on("error", () => {
                clearTimeout(authTimeout);
                clearInterval(pingInterval);
                this.clients.delete(clientId);
            });
        });
    }

    private validateToken(provided: string): boolean {
        const a = Buffer.from(provided);
        const b = Buffer.from(this.token);
        if (a.length !== b.length) {
            timingSafeEqual(b, Buffer.alloc(b.length));
            return false;
        }
        return timingSafeEqual(a, b);
    }

    private wsSend(ws: WebSocket, data: any): void {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    }
}

// ─── Plugin Entry Point ──────────────────────────────────────

export default function (nest: NestAPI): void {
    const serverConfig = nest.config.server as { token?: string } | undefined;
    if (!serverConfig?.token) {
        nest.log.info("CLI plugin: no server token configured, skipping");
        return;
    }

    const listener = new CliListener(nest, serverConfig.token);
    nest.registerListener(listener);

    // Attach to default session (wildcard channel — resolved per-client)
    nest.sessions.attach(nest.sessions.getDefault(), listener, {
        platform: "cli",
        channel: "*",
    });

    // Register upgrade handler for /cli path
    // We need access to the raw HTTP server for WebSocket upgrade.
    // Use a route that signals the server to delegate upgrades.
    nest.registerRoute("GET", "/cli", (_req, res) => {
        // Regular GET returns info; actual WebSocket upgrades are handled below
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ protocol: "websocket", path: "/cli" }));
    });

    // Register WebSocket upgrade handler for /cli
    nest.registerUpgrade("/cli", (req, socket, head) => {
        listener.handleUpgrade(req, socket, head);
    });

    nest.log.info("CLI plugin loaded");
}
