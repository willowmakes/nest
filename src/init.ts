/**
 * nest init — interactive setup wizard
 *
 * Configures:
 *   1. Workspace (working directory for pi)
 *   2. Model provider + API key → writes ~/.pi/agent/models.json
 *   3. Session (name)
 *   4. Listeners (Discord) + credentials
 *   5. HTTP server (port, auth token)
 *   6. Cron directory
 *   7. Writes config.yaml + seeds plugins/
 */

import * as p from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_SOURCE = resolve(__dirname, "..", "plugins");

// ─── Provider Registry ──────────────────────────────────────

interface Provider {
    id: string;
    name: string;
    api: string;
    envVar?: string;
    baseUrl?: string;
    authType: "api-key" | "adc" | "oauth" | "aws";
    hint?: string;
    models: Array<{
        id: string;
        name: string;
        reasoning?: boolean;
        input?: string[];
        contextWindow?: number;
        maxTokens?: number;
    }>;
}

const PROVIDERS: Provider[] = [
    {
        id: "anthropic",
        name: "Anthropic",
        api: "anthropic-messages",
        envVar: "ANTHROPIC_API_KEY",
        authType: "api-key",
        hint: "https://console.anthropic.com/settings/keys",
        models: [
            { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 },
            { id: "claude-opus-4-20250514", name: "Claude Opus 4", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 },
            { id: "claude-haiku-3-5-20241022", name: "Claude Haiku 3.5", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
        ],
    },
    {
        id: "openai",
        name: "OpenAI",
        api: "openai-responses",
        envVar: "OPENAI_API_KEY",
        authType: "api-key",
        hint: "https://platform.openai.com/api-keys",
        models: [
            { id: "o3", name: "o3", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 100000 },
            { id: "gpt-4.1", name: "GPT-4.1", reasoning: false, input: ["text", "image"], contextWindow: 1047576, maxTokens: 32768 },
            { id: "o4-mini", name: "o4-mini", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 100000 },
        ],
    },
    {
        id: "google",
        name: "Google Gemini",
        api: "google-generative-ai",
        envVar: "GEMINI_API_KEY",
        authType: "api-key",
        hint: "https://aistudio.google.com/apikey",
        models: [
            { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
            { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
        ],
    },
    {
        id: "google-vertex",
        name: "Google Vertex AI",
        api: "google-vertex",
        authType: "adc",
        hint: "Run: gcloud auth application-default login",
        models: [
            { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Vertex)", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
        ],
    },
    {
        id: "amazon-bedrock",
        name: "Amazon Bedrock",
        api: "bedrock-converse-stream",
        authType: "aws",
        hint: "Configure AWS credentials (profile, keys, or IAM role)",
        models: [
            { id: "us.anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4 (Bedrock)", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 },
        ],
    },
    {
        id: "azure-openai",
        name: "Azure OpenAI",
        api: "azure-openai-responses",
        envVar: "AZURE_OPENAI_API_KEY",
        authType: "api-key",
        hint: "https://portal.azure.com",
        models: [],
    },
    {
        id: "openrouter",
        name: "OpenRouter",
        api: "openai-completions",
        envVar: "OPENROUTER_API_KEY",
        baseUrl: "https://openrouter.ai/api/v1",
        authType: "api-key",
        hint: "https://openrouter.ai/keys",
        models: [
            { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4 (OpenRouter)", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 },
            { id: "openai/o3", name: "o3 (OpenRouter)", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 100000 },
            { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro (OpenRouter)", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
        ],
    },
    {
        id: "groq",
        name: "Groq",
        api: "openai-completions",
        envVar: "GROQ_API_KEY",
        baseUrl: "https://api.groq.com/openai/v1",
        authType: "api-key",
        hint: "https://console.groq.com/keys",
        models: [
            { id: "llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
        ],
    },
    {
        id: "xai",
        name: "xAI (Grok)",
        api: "openai-completions",
        envVar: "XAI_API_KEY",
        baseUrl: "https://api.x.ai/v1",
        authType: "api-key",
        hint: "https://console.x.ai",
        models: [
            { id: "grok-3", name: "Grok 3", reasoning: false, input: ["text", "image"], contextWindow: 131072, maxTokens: 16384 },
        ],
    },
    {
        id: "mistral",
        name: "Mistral",
        api: "openai-completions",
        envVar: "MISTRAL_API_KEY",
        baseUrl: "https://api.mistral.ai/v1",
        authType: "api-key",
        hint: "https://console.mistral.ai/api-keys",
        models: [
            { id: "codestral-latest", name: "Codestral", reasoning: false, input: ["text"], contextWindow: 256000, maxTokens: 32768 },
        ],
    },
    {
        id: "custom",
        name: "Custom (OpenAI-compatible)",
        api: "openai-completions",
        authType: "api-key",
        hint: "Any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, etc.)",
        models: [],
    },
];

// ─── Helpers ────────────────────────────────────────────────

function generateToken(): string {
    return `nest_${randomBytes(24).toString("base64url")}`;
}

function cancelled(): never {
    p.cancel("Setup cancelled.");
    process.exit(1);
}

function guard<T>(value: T | symbol): T {
    if (typeof value === "symbol") cancelled();
    return value as T;
}

function maskKey(key: string): string {
    if (key.length <= 8) return "••••••••";
    return key.slice(0, 4) + "•".repeat(Math.min(key.length - 8, 32)) + key.slice(-4);
}

// ─── models.json Writer ─────────────────────────────────────

interface ModelsJsonProvider {
    baseUrl?: string;
    api: string;
    apiKey?: string;
    authHeader?: boolean;
    models?: Array<Record<string, unknown>>;
}

function buildModelsJson(
    provider: Provider,
    apiKey: string | undefined,
    customConfig?: { baseUrl: string; modelId: string },
): Record<string, unknown> {
    // For built-in providers (anthropic, openai, google), we only need
    // to override the apiKey. Pi already has their models registered.
    // For custom/third-party providers, we specify everything.

    const isBuiltin = ["anthropic", "openai", "google"].includes(provider.id);

    if (isBuiltin) {
        // Overriding a built-in provider — just set the key
        return {
            providers: {
                [provider.id]: {
                    apiKey: apiKey ?? provider.envVar,
                },
            },
        };
    }

    // ADC-based providers (vertex, bedrock) — no apiKey needed
    if (provider.authType === "adc" || provider.authType === "aws") {
        return {
            providers: {
                [provider.id]: {
                    api: provider.api,
                    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
                    models: provider.models.map((m) => ({
                        id: m.id,
                        name: m.name,
                        ...(m.reasoning ? { reasoning: true } : {}),
                        ...(m.input ? { input: m.input } : {}),
                        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
                        ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
                    })),
                },
            },
        };
    }

    // Custom provider
    if (provider.id === "custom" && customConfig) {
        return {
            providers: {
                custom: {
                    baseUrl: customConfig.baseUrl,
                    api: provider.api,
                    apiKey: apiKey ?? "custom",
                    models: [{ id: customConfig.modelId }],
                },
            },
        };
    }

    // Third-party providers (openrouter, groq, xai, mistral, etc.)
    const entry: ModelsJsonProvider = {
        api: provider.api,
        apiKey: apiKey ?? provider.envVar,
    };
    if (provider.baseUrl) entry.baseUrl = provider.baseUrl;
    if (provider.models.length > 0) {
        entry.models = provider.models.map((m) => ({
            id: m.id,
            name: m.name,
            ...(m.reasoning ? { reasoning: true } : {}),
            ...(m.input ? { input: m.input } : {}),
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
        }));
    }

    return {
        providers: {
            [provider.id]: entry,
        },
    };
}

function mergeModelsJson(
    existing: Record<string, any>,
    newEntry: Record<string, any>,
): Record<string, any> {
    const providers = { ...(existing.providers ?? {}), ...(newEntry.providers ?? {}) };
    return { ...existing, providers };
}

// ─── config.yaml Builder ────────────────────────────────────

interface WizardState {
    instanceName: string;
    nestDir: string;        // ~/.nest/<name>/ — config, plugins, data all live here
    workDir: string;        // pi's cwd (where the agent works)
    provider: Provider;
    apiKey?: string;
    customBaseUrl?: string;
    customModelId?: string;
    sessionName: string;

    enableDiscord: boolean;
    discordToken?: string;
    discordChannels: Record<string, string>;
    enableServer: boolean;
    serverPort: number;
    serverToken?: string;
    enableCron: boolean;
    cronDir: string;
    enableSandbox: boolean;
    rootlessDocker: boolean;
    lanIsolation: boolean;
    lanAllow: string[];         // allowed LAN addresses/CIDRs
    extraMounts: string[];      // additional bind mounts (host:container[:opts])
}

function buildConfig(state: WizardState): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    // Instance
    const instance: Record<string, unknown> = {
        name: state.instanceName,
        dataDir: ".",
        pluginsDir: "./plugins",
        agentDir: "./.pi/agent",
    };
    config.instance = instance;

    // Sessions
    const sessionConfig: Record<string, unknown> = {
        pi: {
            cwd: state.workDir,
        },
    };
    config.sessions = { [state.sessionName]: sessionConfig };
    config.defaultSession = state.sessionName;

    // Server
    if (state.enableServer) {
        config.server = {
            port: state.serverPort,
            token: state.serverToken,
            host: "127.0.0.1",
        };
    }

    // Cron
    if (state.enableCron) {
        config.cron = {
            dir: state.cronDir,
            gracePeriodMs: 5000,
        };
    }

    // Tracking
    config.tracking = {
        usageLog: "./.usage.jsonl",
        capacity: 1000,
        retentionDays: 30,
    };

    // Discord
    if (state.enableDiscord) {
        config.discord = {
            token: state.discordToken,
            channels: state.discordChannels,
        };
    }

    return config;
}

// ─── Wizard Steps ───────────────────────────────────────────

async function stepInstance(hint?: string): Promise<{ instanceName: string; nestDir: string }> {
    const defaultName = hint?.replace(/[^a-z0-9_-]/gi, "-").toLowerCase() ?? "default";
    const instanceName = guard(
        await p.text({
            message: "Instance name",
            initialValue: defaultName,
            validate: (v = "") => {
                if (!v.trim()) return "Required";
                if (!/^[a-z0-9_-]+$/.test(v)) return "Lowercase alphanumeric, hyphens, underscores only";
                return undefined;
            },
        }),
    );

    const defaultDir = join(homedir(), ".nest", instanceName);
    const nestDir = guard(
        await p.text({
            message: "Workspace directory",
            initialValue: defaultDir,
            validate: (v = "") => {
                if (!v.trim()) return "Required";
                return undefined;
            },
        }),
    );

    return { instanceName, nestDir: resolve(nestDir) };
}

async function stepWorkDir(): Promise<string> {
    const cwd = guard(
        await p.text({
            message: "Working directory for the agent (pi's cwd)",
            initialValue: process.env.HOME ?? "/home",
            validate: (v = "") => {
                if (!v.trim()) return "Required";
                return undefined;
            },
        }),
    );
    return resolve(cwd);
}

async function stepProvider(): Promise<{
    provider: Provider;
    apiKey?: string;
    customBaseUrl?: string;
    customModelId?: string;
}> {
    const providerId = guard(
        await p.select({
            message: "Model provider",
            options: PROVIDERS.map((prov) => ({
                value: prov.id,
                label: prov.name,
                hint: prov.hint,
            })),
        }),
    );
    const provider = PROVIDERS.find((pv) => pv.id === providerId)!;

    let apiKey: string | undefined;
    let customBaseUrl: string | undefined;
    let customModelId: string | undefined;

    if (provider.authType === "api-key" && provider.id !== "custom") {
        // Check env first
        const envKey = provider.envVar ? process.env[provider.envVar] : undefined;
        if (envKey) {
            const useEnv = guard(
                await p.confirm({
                    message: `Found ${provider.envVar} in environment (${maskKey(envKey)}). Use it?`,
                    initialValue: true,
                }),
            );
            if (useEnv) {
                apiKey = provider.envVar; // Store as env var reference
            }
        }

        if (!apiKey) {
            const key = guard(
                await p.text({
                    message: `${provider.name} API key`,
                    placeholder: provider.hint,
                    validate: (v = "") => {
                        if (!v.trim()) return "Required";
                        return undefined;
                    },
                }),
            );
            apiKey = key;
        }
    } else if (provider.id === "custom") {
        customBaseUrl = guard(
            await p.text({
                message: "Base URL",
                placeholder: "http://localhost:11434/v1",
                validate: (v = "") => {
                    if (!v.trim()) return "Required";
                    try {
                        new URL(v);
                    } catch {
                        return "Invalid URL";
                    }
                    return undefined;
                },
            }),
        );

        customModelId = guard(
            await p.text({
                message: "Model ID",
                placeholder: "llama3.1:8b",
                validate: (v = "") => {
                    if (!v.trim()) return "Required";
                    return undefined;
                },
            }),
        );

        const needsKey = guard(
            await p.confirm({
                message: "Does this endpoint require an API key?",
                initialValue: false,
            }),
        );

        if (needsKey) {
            apiKey = guard(
                await p.text({
                    message: "API key",
                    validate: (v = "") => {
                        if (!v.trim()) return "Required";
                        return undefined;
                    },
                }),
            );
        }
    } else if (provider.authType === "adc") {
        // Google Vertex — check for ADC
        p.note(
            [
                "Vertex AI uses Application Default Credentials.",
                "Run: gcloud auth application-default login",
                "",
                "Required env vars:",
                "  GOOGLE_CLOUD_PROJECT  — your GCP project ID",
                "  GOOGLE_CLOUD_LOCATION — e.g. us-central1",
            ].join("\n"),
            "Google Vertex AI",
        );

        const ready = guard(
            await p.confirm({
                message: "Are ADC credentials configured?",
                initialValue: true,
            }),
        );
        if (!ready) {
            p.log.warn("Set up ADC before starting nest. Continuing with config generation.");
        }
    } else if (provider.authType === "aws") {
        p.note(
            [
                "Bedrock uses the AWS credential chain.",
                "Options: AWS_PROFILE, IAM keys, ECS/EKS roles.",
                "",
                "Required env vars:",
                "  AWS_REGION — e.g. us-east-1",
            ].join("\n"),
            "Amazon Bedrock",
        );

        const ready = guard(
            await p.confirm({
                message: "Are AWS credentials configured?",
                initialValue: true,
            }),
        );
        if (!ready) {
            p.log.warn("Set up AWS credentials before starting nest. Continuing with config generation.");
        }
    }

    return { provider, apiKey, customBaseUrl, customModelId };
}

async function stepSession(): Promise<{ name: string }> {
    const name = guard(
        await p.text({
            message: "Session name",
            initialValue: "default",
            validate: (v = "") => {
                if (!v.trim()) return "Required";
                if (!/^[a-z0-9_-]+$/.test(v)) return "Lowercase alphanumeric, hyphens, underscores only";
                return undefined;
            },
        }),
    );

    // Extensions are auto-discovered from plugin pi.ts files — no manual config needed.

    return { name };
}

async function stepListeners(sessionName: string): Promise<{
    enableDiscord: boolean;
    discordToken?: string;
    discordChannels: Record<string, string>;
}> {
    const enableDiscord = guard(
        await p.confirm({
            message: "Enable Discord?",
            initialValue: false,
        }),
    );
    let discordToken: string | undefined;
    const discordChannels: Record<string, string> = {};

    if (enableDiscord) {
        // Check env
        const envToken = process.env.DISCORD_TOKEN;
        if (envToken) {
            const useEnv = guard(
                await p.confirm({
                    message: `Found DISCORD_TOKEN in environment (${maskKey(envToken)}). Use it?`,
                    initialValue: true,
                }),
            );
            discordToken = useEnv ? "env:DISCORD_TOKEN" : undefined;
        }

        if (!discordToken) {
            discordToken = guard(
                await p.text({
                    message: "Discord bot token",
                    validate: (v = "") => {
                        if (!v.trim()) return "Required";
                        return undefined;
                    },
                }),
            );
        }

        // Channel mapping
        let addMore = true;
        while (addMore) {
            const channelId = guard(
                await p.text({
                    message: "Discord channel ID",
                    placeholder: "1234567890123456789",
                    validate: (v = "") => {
                        if (!v.trim()) return "Required";
                        if (!/^\d+$/.test(v)) return "Must be a numeric ID";
                        return undefined;
                    },
                }),
            );

            const targetSession = guard(
                await p.text({
                    message: "Map to session",
                    initialValue: sessionName,
                }),
            );

            discordChannels[channelId] = targetSession;

            addMore = guard(
                await p.confirm({
                    message: "Add another channel?",
                    initialValue: false,
                }),
            );
        }
    }

    return {
        enableDiscord,
        discordToken,
        discordChannels,
    };
}

async function stepServer(): Promise<{
    enable: boolean;
    port: number;
    token?: string;
}> {
    const enable = guard(
        await p.confirm({
            message: "Enable HTTP server?",
            initialValue: true,
        }),
    );

    if (!enable) return { enable: false, port: 0 };

    const portStr = guard(
        await p.text({
            message: "Server port",
            initialValue: "8484",
            validate: (v = "") => {
                const n = parseInt(v, 10);
                if (isNaN(n) || n < 1 || n > 65535) return "Must be 1-65535";
                return undefined;
            },
        }),
    );

    const token = generateToken();
    p.log.info(`Generated auth token: ${token}`);

    return { enable: true, port: parseInt(portStr, 10), token };
}

async function stepCron(): Promise<{ enable: boolean; dir: string }> {
    const enable = guard(
        await p.confirm({
            message: "Enable cron scheduler?",
            initialValue: true,
        }),
    );

    if (!enable) return { enable: false, dir: "" };

    const dir = guard(
        await p.text({
            message: "Cron jobs directory",
            initialValue: "./cron.d",
        }),
    );

    return { enable, dir };
}

interface SandboxResult {
    enable: boolean;
    rootless: boolean;
    lanIsolation: boolean;
    lanAllow: string[];
    extraMounts: string[];
}

async function stepSandbox(): Promise<SandboxResult> {
    const enable = guard(
        await p.confirm({
            message: "Run in Docker sandbox? (isolates filesystem, nix available for deps)",
            initialValue: false,
        }),
    );

    if (!enable) return { enable: false, rootless: false, lanIsolation: false, lanAllow: [], extraMounts: [] };

    const rootless = guard(
        await p.confirm({
            message: "Rootless Docker? (container runs as root, mapped to host user)",
            initialValue: false,
        }),
    );

    const lanIsolation = guard(
        await p.confirm({
            message: "Enable LAN isolation? (block RFC1918 networks via iptables)",
            initialValue: true,
        }),
    );

    let lanAllow: string[] = [];
    if (lanIsolation) {
        const allowInput = guard(
            await p.text({
                message: "Allowed LAN addresses (comma-separated CIDRs, or empty for none)",
                initialValue: "",
                placeholder: "172.30.0.10, 192.168.1.50",
            }),
        );
        lanAllow = allowInput.split(",").map((s) => s.trim()).filter(Boolean);
    }

    const extraMounts: string[] = [];
    const addMounts = guard(
        await p.confirm({
            message: "Add extra bind mounts? (e.g. shared data, vaults)",
            initialValue: false,
        }),
    );

    if (addMounts) {
        let more = true;
        while (more) {
            const mount = guard(
                await p.text({
                    message: "Bind mount (host:container[:opts])",
                    placeholder: "/data/shared:/shared:ro",
                    validate: (v = "") => {
                        if (!v.trim()) return "Required";
                        if (!v.includes(":")) return "Format: host:container[:opts]";
                        return undefined;
                    },
                }),
            );
            extraMounts.push(mount);
            more = guard(
                await p.confirm({
                    message: "Add another mount?",
                    initialValue: false,
                }),
            );
        }
    }

    return { enable, rootless, lanIsolation, lanAllow, extraMounts };
}

// ─── Docker File Generators ─────────────────────────────────

function generateDockerfile(state: WizardState): string {
    const port = state.serverPort || 8484;
    return `# Generated by nest init — edit freely
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx tsc

FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git openssh-client curl wget jq \\
    ripgrep fd-find fzf tree less vim-tiny \\
    build-essential python3 python3-pip python3-venv \\
    ca-certificates dnsutils iptables iproute2 \\
    && rm -rf /var/lib/apt/lists/*
RUN curl -L https://nixos.org/nix/install | sh -s -- --no-daemon \\
    && ln -s /root/.nix-profile/bin/* /usr/local/bin/ 2>/dev/null || true
RUN npm install -g @mariozechner/pi-coding-agent@0.53.1
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/plugins ./plugins
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
    CMD curl -f http://localhost:${port}/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/cli.js", "start", "--config", "/home/nest/config.yaml"]
`;
}

function generateEntrypoint(state: WizardState): string {
    if (!state.lanIsolation) {
        return `#!/bin/sh
set -e
# No LAN isolation configured. Edit this file to add firewall rules.
exec "$@"
`;
    }

    const allowLines = state.lanAllow.map(
        (addr) => `    iptables -A OUTPUT -d ${addr} -j ACCEPT`,
    );
    const allowSection = allowLines.length > 0
        ? `\n    # Allowed LAN addresses\n${allowLines.join("\n")}\n`
        : "";

    return `#!/bin/sh
set -e

# --- LAN Isolation -------------------------------------------
# Block private networks so the agent can't reach LAN services.
# Set NEST_NO_FIREWALL=1 to skip all iptables rules.

if [ "\${NEST_NO_FIREWALL:-}" != "1" ]; then
    # Allow responses to established connections
    iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
${allowSection}
    # Also allow via env var (comma-separated)
    if [ -n "\${NEST_LAN_ALLOW:-}" ]; then
        OLD_IFS="$IFS"
        IFS=','
        for addr in $NEST_LAN_ALLOW; do
            addr=$(echo "$addr" | tr -d ' ')
            [ -n "$addr" ] && iptables -A OUTPUT -d "$addr" -j ACCEPT
        done
        IFS="$OLD_IFS"
    fi

    # Block all private/LAN networks
    iptables -A OUTPUT -d 10.0.0.0/8 -j DROP
    iptables -A OUTPUT -d 172.16.0.0/12 -j DROP
    iptables -A OUTPUT -d 192.168.0.0/16 -j DROP
    iptables -A OUTPUT -d 169.254.0.0/16 -j DROP

    # Disable IPv6 to prevent LAN access via link-local/ULA
    sysctl -w net.ipv6.conf.all.disable_ipv6=1 2>/dev/null || true
fi

# --- Drop Capabilities --------------------------------------
# NET_ADMIN was only needed for iptables setup above.
exec setpriv --no-new-privs --bounding-set=-net_admin,-net_raw -- "$@"
`;
}

function generateCompose(state: WizardState): string {
    const user = state.rootlessDocker ? '\n        user: "0:0"  # rootless Docker: maps to host user' : "";
    const capAdd = state.lanIsolation ? "\n        cap_add:\n            - NET_ADMIN  # for iptables in entrypoint" : "";

    // Build volume list
    const volumes = [
        "            - .:/home/nest               # workspace = home",
        `            - ${state.workDir}:${state.workDir}    # agent working directory`,
        "            - nix-store:/nix              # persistent nix store",
    ];
    for (const mount of state.extraMounts) {
        volumes.push(`            - ${mount}`);
    }

    // Build environment
    const envLines = [
        "            - HOME=/home/nest",
    ];
    if (state.lanIsolation && state.lanAllow.length > 0) {
        envLines.push(`            - NEST_LAN_ALLOW=${state.lanAllow.join(",")}`);
    }

    // Port
    const port = state.serverPort || 8484;

    return `# Generated by nest init — edit freely
services:
    nest:
        build: .
        restart: unless-stopped${user}${capAdd}
        ports:
            - "${port}:${port}"
        volumes:
${volumes.join("\n")}
        environment:
${envLines.join("\n")}
        env_file:
            - .env

volumes:
    nix-store:
`;
}

function generateEnvExample(state: WizardState): string {
    const lines: string[] = ["# Generated by nest init — copy to .env and fill in values"];
    if (state.enableDiscord) lines.push("DISCORD_TOKEN=your-discord-bot-token");
    if (state.enableServer) lines.push(`SERVER_TOKEN=${state.serverToken ?? "generate-a-token"}`);
    if (state.provider.envVar) lines.push(`${state.provider.envVar}=your-api-key`);
    lines.push("");
    return lines.join("\n");
}

// ─── Output ─────────────────────────────────────────────────

function writeOutput(state: WizardState): void {
    const configDir = process.cwd();

    // 1. Write config.yaml
    const config = buildConfig(state);
    const configYaml = yaml.dump(config, {
        lineWidth: -1,
        noRefs: true,
        quotingType: '"',
        forceQuotes: false,
    });
    const configPath = join(configDir, "config.yaml");
    const configExisted = existsSync(configPath);
    writeFileSync(configPath, configYaml, "utf-8");
    p.log.success(`${configExisted ? "Updated" : "Written"}: config.yaml`);

    // 2. Write models.json to workspace's .pi/agent/ (doesn't touch ~/.pi/agent/)
    const piAgentDir = join(configDir, ".pi", "agent");
    mkdirSync(piAgentDir, { recursive: true });
    const modelsPath = join(piAgentDir, "models.json");
    const modelsJson = buildModelsJson(
        state.provider,
        state.apiKey,
        state.customBaseUrl && state.customModelId
            ? { baseUrl: state.customBaseUrl, modelId: state.customModelId }
            : undefined,
    );

    // Merge with existing models.json
    let finalModels = modelsJson;
    if (existsSync(modelsPath)) {
        try {
            const existing = JSON.parse(readFileSync(modelsPath, "utf-8"));
            finalModels = mergeModelsJson(existing, modelsJson);
        } catch {
            // If existing file is invalid, overwrite
        }
    }

    writeFileSync(modelsPath, JSON.stringify(finalModels, null, 2) + "\n", "utf-8");
    p.log.success(`Written: ${modelsPath} (isolated from ~/.pi/agent/)`);

    // 2b. Write AGENTS.md to workspace's .pi/agent/ (nest context for the agent)
    const agentsPath = join(piAgentDir, "AGENTS.md");
    if (!existsSync(agentsPath)) {
        const agentsSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "AGENTS.md.example");
        if (existsSync(agentsSrc)) {
            copyFileSync(agentsSrc, agentsPath);
            p.log.success(`Written: ${agentsPath}`);
        }
    } else {
        p.log.info(`Exists: ${agentsPath} (skipped)`);
    }

    // 3. Seed plugins directory
    const pluginsDir = join(configDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });

    // Plugins are ESM — tsx needs this to avoid CJS fallback
    const pluginsPkg = join(pluginsDir, "package.json");
    if (!existsSync(pluginsPkg)) {
        writeFileSync(pluginsPkg, '{"type": "module"}\n');
    }

    // Each plugin is a subdirectory with nest.ts and/or pi.ts
    const pluginDirs: string[] = ["core", "commands"];
    if (state.enableServer) pluginDirs.push("cli", "dashboard", "webhook");
    if (state.enableDiscord) pluginDirs.push("discord");

    for (const pluginName of pluginDirs) {
        const srcDir = join(PLUGINS_SOURCE, pluginName);
        const destDir = join(pluginsDir, pluginName);
        if (!existsSync(srcDir)) {
            p.log.warn(`Plugin source not found: ${srcDir}`);
            continue;
        }
        if (existsSync(destDir)) {
            p.log.info(`Exists: plugins/${pluginName}/ (skipped)`);
            continue;
        }
        cpSync(srcDir, destDir, { recursive: true });
        p.log.success(`Copied: plugins/${pluginName}/`);
    }

    // 4. Create cron directory
    if (state.enableCron) {
        const cronDir = resolve(configDir, state.cronDir);
        mkdirSync(cronDir, { recursive: true });
        p.log.success(`Created: ${state.cronDir}/`);
    }

    // 5. Create usage log directory
    const usageDir = resolve(configDir);
    if (!existsSync(join(usageDir, ".usage.jsonl"))) {
        writeFileSync(join(usageDir, ".usage.jsonl"), "", "utf-8");
    }

    // 6. Docker sandbox files
    if (state.enableSandbox) {
        const dockerfilePath = join(configDir, "Dockerfile");
        if (!existsSync(dockerfilePath)) {
            writeFileSync(dockerfilePath, generateDockerfile(state), "utf-8");
            p.log.success("Written: Dockerfile");
        } else {
            p.log.info("Exists: Dockerfile (skipped)");
        }

        const composePath = join(configDir, "docker-compose.yml");
        if (!existsSync(composePath)) {
            writeFileSync(composePath, generateCompose(state), "utf-8");
            p.log.success("Written: docker-compose.yml");
        } else {
            p.log.info("Exists: docker-compose.yml (skipped)");
        }

        const entrypointPath = join(configDir, "entrypoint.sh");
        if (!existsSync(entrypointPath)) {
            writeFileSync(entrypointPath, generateEntrypoint(state), { mode: 0o755 });
            p.log.success("Written: entrypoint.sh");
        } else {
            p.log.info("Exists: entrypoint.sh (skipped)");
        }

        const envExamplePath = join(configDir, ".env.example");
        if (!existsSync(envExamplePath)) {
            writeFileSync(envExamplePath, generateEnvExample(state), "utf-8");
            p.log.success("Written: .env.example");
        } else {
            p.log.info("Exists: .env.example (skipped)");
        }

        // Copy nest source for self-contained build
        const srcFiles = ["package.json", "package-lock.json", "tsconfig.json"];
        const srcDirs = ["src"];
        const nestRoot = resolve(__dirname, "..");

        for (const file of srcFiles) {
            const src = join(nestRoot, file);
            const dest = join(configDir, file);
            if (existsSync(src) && !existsSync(dest)) {
                copyFileSync(src, dest);
            }
        }

        for (const dir of srcDirs) {
            const src = join(nestRoot, dir);
            const dest = join(configDir, dir);
            if (existsSync(src) && !existsSync(dest)) {
                cpSync(src, dest, { recursive: true });
            }
        }

        p.log.success("Copied nest source for self-contained Docker build");
    }
}

// ─── Exported Wizard ────────────────────────────────────────

export interface InitResult {
    instanceName: string;
    nestDir: string;
}

export async function runInitWizard(nameHint?: string): Promise<InitResult | null> {
    p.intro("🪺 nest init");

    // Step 1: Instance name → derives ~/.nest/<name>/
    p.log.step("Instance");
    const { instanceName, nestDir } = await stepInstance(nameHint);

    // Check for existing config in that workspace
    mkdirSync(nestDir, { recursive: true });
    const configPath = join(nestDir, "config.yaml");
    if (existsSync(configPath)) {
        const overwrite = guard(
            await p.confirm({
                message: `${configPath} already exists. Overwrite?`,
                initialValue: false,
            }),
        );
        if (!overwrite) {
            p.cancel("Keeping existing config.");
            return null;
        }
    }

    // Step 2: Working directory for pi
    p.log.step("Agent Working Directory");
    const workDir = await stepWorkDir();

    // Step 3: Model provider
    p.log.step("Model Provider");
    const { provider, apiKey, customBaseUrl, customModelId } = await stepProvider();

    // Step 4: Session
    p.log.step("Session");
    const session = await stepSession();

    // Step 5: Listeners
    p.log.step("Chat Platforms");
    const listeners = await stepListeners(session.name);

    // Step 6: Server
    p.log.step("HTTP Server");
    const server = await stepServer();

    // Step 7: Cron
    p.log.step("Cron Scheduler");
    const cron = await stepCron();

    // Step 8: Sandbox
    p.log.step("Sandbox");
    const sandbox = await stepSandbox();

    // Write everything to ~/.nest/<name>/
    process.chdir(nestDir);

    const state: WizardState = {
        instanceName,
        nestDir,
        workDir,
        provider,
        apiKey,
        customBaseUrl,
        customModelId,
        sessionName: session.name,
        ...listeners,
        enableServer: server.enable,
        serverPort: server.port,
        serverToken: server.token,
        enableCron: cron.enable,
        cronDir: cron.dir,
        enableSandbox: sandbox.enable,
        rootlessDocker: sandbox.rootless,
        lanIsolation: sandbox.lanIsolation,
        lanAllow: sandbox.lanAllow,
        extraMounts: sandbox.extraMounts,
    };

    p.log.step("Writing configuration");
    writeOutput(state);

    // Summary
    const summaryLines = [
        `Instance:  ${instanceName}`,
        `Location:  ${nestDir}`,
        `Provider:  ${provider.name}`,
        `Session:   ${session.name}`,
        `Agent cwd: ${workDir}`,
        `Pi config: ${nestDir}/.pi/agent/`,
    ];
    if (listeners.enableDiscord) {
        summaryLines.push(`Discord:   ${Object.keys(listeners.discordChannels).length} channel(s)`);
    }
    if (server.enable) {
        summaryLines.push(`Server:    http://127.0.0.1:${server.port}`);
    }
    if (cron.enable) {
        summaryLines.push(`Cron:      ${cron.dir}`);
    }
    if (sandbox.enable) {
        const sandboxDetails = [
            "Docker",
            sandbox.rootless ? "(rootless)" : "",
            sandbox.lanIsolation ? "+ LAN isolation" : "",
        ].filter(Boolean).join(" ");
        summaryLines.push(`Sandbox:   ${sandboxDetails}`);
        summaryLines.push(`Docker:    Dockerfile, docker-compose.yml, entrypoint.sh generated`);
    } else {
        summaryLines.push(`Sandbox:   none (bare-metal)`);
    }

    p.note(summaryLines.join("\n"), "Setup complete");

    p.outro(`Start with: nest -w ${instanceName} start`);

    return { instanceName, nestDir };
}
