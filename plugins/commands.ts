/**
 * Extended commands plugin for nest.
 *
 * Adds: model, think, compress, new, reload
 * (Core commands status/reboot/abort live in the kernel.)
 */
import type { NestAPI } from "nest";

export default function (nest: NestAPI): void {
    const thinkingState = new Map<string, boolean>();

    nest.registerCommand("model", {
        async execute({ args, bridge, reply }) {
            if (!args) {
                const [modelsResult, stateResult] = await Promise.all([
                    bridge.command("get_available_models"),
                    bridge.command("get_state"),
                ]);
                const models: any[] = modelsResult?.models ?? [];
                const current = stateResult?.model;
                const currentLine = current
                    ? `**Current model:** ${current.name} (\`${current.provider}/${current.id}\`)`
                    : "**Current model:** unknown";
                const list = models.map((m: any) => `- \`${m.provider}/${m.id}\` -- ${m.name}`).join("\n");
                await reply(`${currentLine}\n\n**Available models:**\n${list}\n\nUse \`bot!model <name>\` to switch.`);
            } else {
                const result = await bridge.command("get_available_models");
                const models: any[] = result?.models ?? [];
                const query = args.toLowerCase();
                const match = models.find(
                    (m: any) =>
                        m.id.toLowerCase().includes(query) ||
                        m.name.toLowerCase().includes(query) ||
                        `${m.provider}/${m.id}`.toLowerCase().includes(query),
                );
                if (!match) {
                    await reply(`No model matching \`${args}\`.`);
                } else {
                    await bridge.command("set_model", { provider: match.provider, modelId: match.id });
                    await reply(`Switched to **${match.name}** (\`${match.provider}/${match.id}\`).`);
                }
            }
        },
    });

    nest.registerCommand("think", {
        async execute({ args, bridge, reply, sessionName }) {
            const arg = args.toLowerCase().trim();
            if (arg === "on" || arg === "off") {
                const level = arg === "on" ? "medium" : "off";
                await bridge.command("set_thinking_level", { level });
                thinkingState.set(sessionName, arg === "on");
                await reply(`Extended thinking ${arg === "on" ? "enabled" : "disabled"} for **${sessionName}**.`);
            } else if (["minimal", "low", "medium", "high"].includes(arg)) {
                await bridge.command("set_thinking_level", { level: arg });
                thinkingState.set(sessionName, true);
                await reply(`Extended thinking set to **${arg}** for **${sessionName}**.`);
            } else {
                const state = thinkingState.get(sessionName) ? "on" : "off";
                await reply(`Extended thinking: **${state}** for **${sessionName}**.\nUsage: \`bot!think on|off|minimal|low|medium|high\``);
            }
        },
    });

    nest.registerCommand("compress", {
        async execute({ args, bridge, reply }) {
            await reply("Compressing context...");
            const result = await bridge.command("compact", args ? { customInstructions: args } : {});
            await reply(`Compressed. Tokens before: ${result?.tokensBefore ?? "?"}`);
        },
    });

    nest.registerCommand("new", {
        interrupts: true,
        async execute({ bridge, reply }) {
            await bridge.command("new_session");
            await reply("Started a new session.");
        },
    });

    nest.registerCommand("reload", {
        interrupts: true,
        async execute({ bridge, reply }) {
            await reply("Reloading extensions...");
            await bridge.command("prompt", { message: "/reload-runtime" });
            await reply("Extensions reloaded.");
        },
    });

    nest.log.info("Commands plugin loaded: model, think, compress, new, reload");
}
