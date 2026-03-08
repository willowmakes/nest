/**
 * Discord-specific agent tools — interactive prompts using Discord UI components.
 *
 * Tools: discord_confirm, discord_select
 *
 * These tools send interactive buttons/dropdowns to the Discord channel
 * where the user is chatting and wait for their response.
 *
 * Requires NEST_URL and SERVER_TOKEN environment variables.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const NEST_URL = process.env.NEST_URL ?? "http://127.0.0.1:8484";
const NEST_TOKEN = process.env.SERVER_TOKEN ?? "";

async function sendPrompt(block: Record<string, unknown>, timeoutMs = 30_000): Promise<{ ok: boolean; value?: unknown; cancelled?: boolean; error?: string }> {
    const res = await fetch(`${NEST_URL}/api/block`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${NEST_TOKEN}`,
        },
        body: JSON.stringify({
            block,
            prompt: true,
            timeout: timeoutMs,
        }),
    });
    return res.json() as any;
}

export default function (pi: ExtensionAPI) {

    pi.registerTool({
        name: "discord_confirm",
        label: "Discord Confirm",
        description:
            "Show a Yes/No confirmation prompt with Discord buttons. " +
            "Returns the user's choice (true/false) or null if they don't respond in time. " +
            "Only works when the user is chatting via Discord.",
        parameters: Type.Object({
            message: Type.String({ description: "The question to ask" }),
            timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)" })),
        }),
        async execute(_id, params) {
            const result = await sendPrompt({
                id: `confirm-${Date.now()}`,
                kind: "confirm",
                data: { text: params.message },
                fallback: `[Confirm: ${params.message}]`,
            }, (params.timeout ?? 30) * 1000);

            if (!result.ok || result.cancelled) {
                return { content: [{ type: "text" as const, text: "User did not respond in time." }] };
            }
            return { content: [{ type: "text" as const, text: result.value ? "User confirmed: Yes" : "User declined: No" }] };
        },
    });

    pi.registerTool({
        name: "discord_select",
        label: "Discord Select",
        description:
            "Show a dropdown menu with Discord select components. " +
            "Returns the user's selection or null if they don't respond in time. " +
            "Only works when the user is chatting via Discord.",
        parameters: Type.Object({
            message: Type.String({ description: "Prompt text shown above the dropdown" }),
            options: Type.Array(
                Type.Object({
                    value: Type.String({ description: "The value returned when selected" }),
                    label: Type.String({ description: "Display label" }),
                    description: Type.Optional(Type.String({ description: "Description shown below the label" })),
                }),
                { description: "Options to show in the dropdown (max 25)" },
            ),
            timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)" })),
        }),
        async execute(_id, params) {
            const result = await sendPrompt({
                id: `select-${Date.now()}`,
                kind: "select",
                data: { text: params.message, items: params.options },
                fallback: `[Select: ${params.message}]`,
            }, (params.timeout ?? 30) * 1000);

            if (!result.ok || result.cancelled) {
                return { content: [{ type: "text" as const, text: "User did not respond in time." }] };
            }
            return { content: [{ type: "text" as const, text: `User selected: ${result.value}` }] };
        },
    });
}
