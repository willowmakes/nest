/**
 * Core nest extension — provides the agent with tools to manage nest
 * and send files/attachments to users.
 *
 * Tools: nest_command, nest_reboot, nest_model, nest_compress, attach
 *
 * Requires NEST_URL and SERVER_TOKEN environment variables.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const NEST_URL = process.env.NEST_URL ?? "http://127.0.0.1:8484";
const NEST_TOKEN = process.env.SERVER_TOKEN ?? "";

// ─── Helpers ─────────────────────────────────────────────

async function runCommand(command: string, args?: string, session?: string): Promise<{ ok: boolean; replies: string[]; error?: string }> {
    const res = await fetch(`${NEST_URL}/api/command`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${NEST_TOKEN}`,
        },
        body: JSON.stringify({ command, args, session }),
    });
    return res.json() as any;
}

async function listCommands(): Promise<string[]> {
    const res = await fetch(`${NEST_URL}/api/commands`, {
        headers: { "Authorization": `Bearer ${NEST_TOKEN}` },
    });
    const data = await res.json() as any;
    return data.commands ?? [];
}

const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

const MIME: Record<string, string> = {
    ...IMAGE_MIME,
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".mp4": "video/mp4", ".webm": "video/webm",
    ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
    ".json": "application/json", ".csv": "text/csv", ".zip": "application/zip",
    ".tar": "application/x-tar", ".gz": "application/gzip",
};

// ─── Extension ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {

    // ─── Nest Commands ───────────────────────────────────

    pi.registerTool({
        name: "nest_command",
        label: "Nest Command",
        description:
            "Execute a nest bot command. Use this to manage sessions, switch models, " +
            "reboot after writing plugins, compress context, etc. " +
            "Call with no arguments to list available commands.",
        parameters: Type.Object({
            command: Type.Optional(Type.String({ description: "Command name (e.g. 'reboot', 'model', 'compress'). Omit to list available commands." })),
            args: Type.Optional(Type.String({ description: "Arguments to pass to the command" })),
            session: Type.Optional(Type.String({ description: "Target session (defaults to current)" })),
        }),
        async execute(_id, params) {
            if (!params.command) {
                const cmds = await listCommands();
                return {
                    content: [{ type: "text" as const, text: `Available nest commands: ${cmds.join(", ")}` }],
                };
            }

            const result = await runCommand(params.command, params.args, params.session);
            const text = result.ok
                ? result.replies.join("\n") || `Command '${params.command}' completed.`
                : `Error: ${result.error}`;

            return { content: [{ type: "text" as const, text }] };
        },
    });

    pi.registerTool({
        name: "nest_reboot",
        label: "Reboot Session",
        description: "Reboot the nest session. Use after writing or modifying plugins.",
        parameters: Type.Object({
            session: Type.Optional(Type.String({ description: "Target session (defaults to current)" })),
        }),
        async execute(_id, params) {
            const result = await runCommand("reboot", params.session ?? "", params.session);
            return { content: [{ type: "text" as const, text: result.replies.join("\n") || "Rebooted." }] };
        },
    });

    pi.registerTool({
        name: "nest_model",
        label: "Switch Model",
        description: "Switch the AI model for the current session. Call with no model to list available models.",
        parameters: Type.Object({
            model: Type.Optional(Type.String({ description: "Model name or ID to switch to. Omit to list available." })),
        }),
        async execute(_id, params) {
            const result = await runCommand("model", params.model ?? "");
            return { content: [{ type: "text" as const, text: result.replies.join("\n") }] };
        },
    });

    pi.registerTool({
        name: "nest_compress",
        label: "Compress Context",
        description: "Compress the conversation context to free up token space.",
        parameters: Type.Object({
            instructions: Type.Optional(Type.String({ description: "Custom compression instructions" })),
        }),
        async execute(_id, params) {
            const result = await runCommand("compress", params.instructions ?? "");
            return { content: [{ type: "text" as const, text: result.replies.join("\n") }] };
        },
    });

    // ─── File Attachment ─────────────────────────────────

    pi.registerTool({
        name: "attach",
        label: "Attach File",
        description:
            "Send a file to the user. Images display inline, other files are sent " +
            "as downloadable attachments. Works across all platforms (Discord, CLI, etc.).",
        parameters: Type.Object({
            path: Type.String({ description: "Absolute path to the file" }),
            filename: Type.Optional(Type.String({ description: "Override the display filename" })),
            caption: Type.Optional(Type.String({ description: "Caption or description" })),
        }),
        async execute(_id, params) {
            const data = await readFile(params.path);
            const ext = extname(params.path).toLowerCase();
            const mimeType = MIME[ext] ?? "application/octet-stream";
            const filename = params.filename ?? basename(params.path);
            const isImage = ext in IMAGE_MIME;
            const kind = isImage ? "image" : "file";
            const sizeKB = Math.round(data.length / 1024);

            const fallback = isImage
                ? `[Image: ${filename}${params.caption ? ` — ${params.caption}` : ""}]`
                : `[File: ${filename} (${sizeKB}KB)${params.caption ? ` — ${params.caption}` : ""}]`;

            const form = new FormData();
            form.set("session", "default");
            form.set("id", `${kind}-${Date.now()}`);
            form.set("kind", kind);
            form.set("filename", filename);
            form.set("mimeType", mimeType);
            form.set("fallback", fallback);
            form.set("file", new Blob([data]), filename);

            const res = await fetch(`${NEST_URL}/api/block/upload`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${NEST_TOKEN}` },
                body: form,
            });
            const result = await res.json() as { ok: boolean; error?: string };

            const action = isImage ? "Displayed" : "Sent";
            return {
                content: [{ type: "text" as const, text: result.ok ? `${action} ${filename}` : `Failed: ${result.error}` }],
            };
        },
    });
}
