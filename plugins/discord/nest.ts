/**
 * Discord listener plugin for nest.
 *
 * Config section (in config.yaml):
 *   discord:
 *     token: "env:DISCORD_TOKEN"
 *     channels:
 *       "channel_id": "session_name"
 */
import { Client, Intents, MessageAttachment } from "discord.js";
import type { NestAPI, Listener, IncomingMessage, MessageOrigin, Attachment, OutgoingFile, Block } from "nest";


const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

async function downloadAttachment(url: string, maxSize: number): Promise<Buffer | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.length > maxSize ? null : buf;
    } catch {
        return null;
    }
}

class DiscordListener implements Listener {
    readonly name = "discord";
    private client: Client;
    private token: string;
    private nestUrl: string;
    private nestToken: string;
    private notifyChannel: string | null;
    private allowedUsers: Set<string> | null;
    private splitMessage: (text: string, maxLength?: number) => string[];
    private messageHandler?: (msg: IncomingMessage) => void;
    private emojiCache = new Map<string, { id: string; animated: boolean }>();

    constructor(token: string, nestUrl: string, nestToken: string, splitMessage: (text: string, maxLength?: number) => string[], notifyChannel?: string, allowedUsers?: string[]) {
        this.token = token;
        this.nestUrl = nestUrl;
        this.nestToken = nestToken;
        this.splitMessage = splitMessage;
        this.notifyChannel = notifyChannel ?? null;
        this.allowedUsers = allowedUsers?.length ? new Set(allowedUsers) : null;
        this.client = new Client({
            intents: [
                Intents.FLAGS.GUILDS,
                Intents.FLAGS.GUILD_MESSAGES,
                Intents.FLAGS.MESSAGE_CONTENT,
                Intents.FLAGS.DIRECT_MESSAGES,
                Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
            ],
        });
    }

    async connect(): Promise<void> {
        this.client.on("messageCreate", async (message) => {
            if (!this.messageHandler || message.author.bot) return;
            if (this.allowedUsers && !this.allowedUsers.has(message.author.username)) return;

            const attachments: Attachment[] = [];
            for (const [, att] of message.attachments) {
                if (att.size > MAX_ATTACHMENT_SIZE) continue;
                const contentType = att.contentType ?? "application/octet-stream";
                const data = await downloadAttachment(att.url, MAX_ATTACHMENT_SIZE);
                if (!data) continue;

                attachments.push({
                    url: att.url,
                    filename: att.name ?? "attachment",
                    contentType,
                    size: data.length,
                    data,
                });
            }

            this.messageHandler({
                platform: "discord",
                channel: message.channelId,
                sender: message.author.username,
                text: message.content,
                attachments: attachments.length > 0 ? attachments : undefined,
            });
        });

        this.client.on("emojiCreate", () => this.buildEmojiCache());
        this.client.on("emojiDelete", () => this.buildEmojiCache());
        this.client.on("emojiUpdate", () => this.buildEmojiCache());

        await new Promise<void>((resolve, reject) => {
            this.client.once("ready", () => {
                this.buildEmojiCache();
                resolve();
            });
            this.client.login(this.token).catch(reject);
        });
    }

    async disconnect(): Promise<void> {
        await this.client.destroy();
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler;
    }

    async sendTyping(origin: MessageOrigin): Promise<void> {
        const channel = await this.client.channels.fetch(origin.channel);
        if (!channel?.isText() || !("sendTyping" in channel)) return;
        await (channel as any).sendTyping();
    }

    notifyOrigin(): MessageOrigin | null {
        if (!this.notifyChannel) return null;
        return { platform: "discord", channel: this.notifyChannel };
    }

    async send(origin: MessageOrigin, text: string, files?: OutgoingFile[], kind?: "text" | "tool" | "stream", blocks?: Block[]): Promise<void> {
        // Never send streaming deltas to Discord — if this fires,
        // the broadcast filter was bypassed somehow.
        if (kind === "stream") {
            console.warn("[discord] BUG: stream delta reached send() — broadcast filter bypassed");
            return;
        }

        const channel = await this.client.channels.fetch(origin.channel);
        if (!channel?.isText() || !("send" in channel)) return;

        // Handle block protocol — fetch file/image data and send as attachments
        const blockFiles: MessageAttachment[] = [];
        if (blocks?.length) {
            for (const block of blocks) {
                if (block.kind === "__update" || block.kind === "__remove") continue;
                if ((block.kind === "image" || block.kind === "file") && typeof block.data.ref === "string") {
                    try {
                        const url = `${this.nestUrl}${block.data.ref}`;
                        const res = await fetch(url, {
                            headers: { "Authorization": `Bearer ${this.nestToken}` },
                        });
                        if (res.ok) {
                            const buf = Buffer.from(await res.arrayBuffer());
                            const filename = (block.data.filename as string) ?? (block.kind === "image" ? "image.png" : "file");
                            blockFiles.push(new MessageAttachment(buf, filename));
                        }
                    } catch (err) {
                        // Log fetch failures — likely auth or connectivity
                        console.error(`[discord] block data fetch failed: ${err}`);
                    }
                }
                // markdown, code, table — these render fine as text via fallback
                // unknown blocks — fallback is already in text
            }
        }

        const resolvedText = this.resolveEmotes(text);
        const chunks = this.splitMessage(resolvedText);
        const discordFiles = [
            ...(files?.map((f) => new MessageAttachment(f.data, f.filename)) ?? []),
            ...blockFiles,
        ];

        for (let i = 0; i < chunks.length; i++) {
            const payload: any = { content: chunks[i] };
            if (i === 0 && discordFiles.length > 0) payload.files = discordFiles;
            await (channel as any).send(payload);
            if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 250));
        }
    }

    async sendPrompt(origin: MessageOrigin, block: Block, timeoutMs: number): Promise<{ value: unknown } | { cancelled: true }> {
        const channel = await this.client.channels.fetch(origin.channel);
        if (!channel?.isText() || !("send" in channel)) {
            return { cancelled: true };
        }

        if (block.kind === "confirm") {
            const { MessageActionRow, MessageButton } = await import("discord.js");
            const row = new MessageActionRow().addComponents(
                new MessageButton().setCustomId("yes").setLabel("Yes").setStyle("SUCCESS"),
                new MessageButton().setCustomId("no").setLabel("No").setStyle("DANGER"),
            );
            const msg = await (channel as any).send({
                content: (block.data.text as string) ?? block.fallback,
                components: [row],
            });
            try {
                const interaction = await msg.awaitMessageComponent({ time: timeoutMs });
                await interaction.update({ components: [] });
                return { value: interaction.customId === "yes" };
            } catch {
                // Timeout — remove buttons
                await msg.edit({ components: [] }).catch(() => {});
                return { cancelled: true };
            }
        }

        if (block.kind === "select" && Array.isArray(block.data.items)) {
            const { MessageActionRow, MessageSelectMenu } = await import("discord.js");
            const items = block.data.items as Array<{ value: string; label: string; description?: string }>;
            const menu = new MessageSelectMenu()
                .setCustomId("select")
                .setPlaceholder((block.data.text as string) ?? "Choose...")
                .addOptions(items.map((i) => ({
                    value: i.value,
                    label: i.label,
                    description: i.description,
                })));
            const row = new MessageActionRow().addComponents(menu);
            const msg = await (channel as any).send({
                content: (block.data.text as string) ?? block.fallback,
                components: [row],
            });
            try {
                const interaction = await msg.awaitMessageComponent({ time: timeoutMs });
                await interaction.update({ components: [] });
                const values = (interaction as any).values;
                return { value: Array.isArray(values) ? values[0] : values };
            } catch {
                await msg.edit({ components: [] }).catch(() => {});
                return { cancelled: true };
            }
        }

        // input and unknown — Discord can't do inline text input, send fallback
        await (channel as any).send(block.fallback);
        return { cancelled: true };
    }

    private resolveEmotes(text: string): string {
        if (this.emojiCache.size === 0) return text;
        return text.replace(/:([a-zA-Z0-9_]+):/g, (match, name: string) => {
            const emoji = this.emojiCache.get(name);
            if (!emoji) return match;
            return emoji.animated ? `<a:${name}:${emoji.id}>` : `<:${name}:${emoji.id}>`;
        });
    }

    private buildEmojiCache(): void {
        this.emojiCache.clear();
        for (const [, guild] of this.client.guilds.cache) {
            for (const [, emoji] of guild.emojis.cache) {
                if (emoji.name) {
                    this.emojiCache.set(emoji.name, { id: emoji.id, animated: emoji.animated ?? false });
                }
            }
        }
    }
}

// ─── Plugin Entry Point ──────────────────────────────────────

export default function (nest: NestAPI): void {
    const config = nest.config.discord as {
        token: string;
        notify?: string;
        channels?: Record<string, string>;
        allowed_users?: string[];
    } | undefined;
    if (!config?.token) {
        nest.log.info("Discord plugin: no token configured, skipping");
        return;
    }

    const serverConfig = nest.config.server;
    // server.host may be 0.0.0.0 (bind all interfaces) — use 127.0.0.1 for local fetch
    const host = serverConfig?.host === "0.0.0.0" ? "127.0.0.1" : (serverConfig?.host ?? "127.0.0.1");
    const nestUrl = serverConfig ? `http://${host}:${serverConfig.port}` : "http://127.0.0.1:8484";
    const nestToken = serverConfig?.token ?? "";

    const listener = new DiscordListener(config.token, nestUrl, nestToken, nest.utils.splitMessage, config.notify, config.allowed_users);
    if (config.allowed_users?.length) {
        nest.log.info("Discord: user filter active", { allowed: config.allowed_users });
    }
    nest.registerListener(listener);

    // Attach channels to sessions
    if (config.channels) {
        for (const [channelId, sessionName] of Object.entries(config.channels)) {
            nest.sessions.attach(sessionName, listener, {
                platform: "discord",
                channel: channelId,
            });
        }
    } else {
        // Default: attach to default session (all channels go there)
        nest.sessions.attach(nest.sessions.getDefault(), listener, {
            platform: "discord",
            channel: "*",
        });
    }

    nest.log.info("Discord plugin loaded", {
        channels: config.channels ? Object.keys(config.channels).length : "all->default",
    });
}
