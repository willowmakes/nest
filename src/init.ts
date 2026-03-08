/**
 * nest init — interactive setup wizard
 *
 * Configures:
 *   1. Workspace (working directory for pi)
 *   2. Model provider + API key → writes ~/.pi/agent/models.json
 *   3. Session (name, extensions)
 *   4. Listeners (Discord, Matrix) + credentials
 *   5. HTTP server (port, auth token)
 *   6. Cron directory
 *   7. Writes config.yaml + seeds plugins/
 */

import * as p from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
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
    extensions: string[];
    enableDiscord: boolean;
    discordToken?: string;
    discordChannels: Record<string, string>;
    enableMatrix: boolean;
    matrixHomeserver?: string;
    matrixUser?: string;
    matrixToken?: string;
    matrixRooms: Record<string, string>;
    enableServer: boolean;
    serverPort: number;
    serverToken?: string;
    enableCron: boolean;
    cronDir: string;
    enableSandbox: boolean;
    sandboxImage: string;
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
    if (state.enableSandbox) {
        instance.sandbox = {
            enabled: true,
            image: state.sandboxImage,
        };
    }
    config.instance = instance;

    // Sessions
    const sessionConfig: Record<string, unknown> = {
        pi: {
            cwd: state.workDir,
            ...(state.extensions.length > 0 ? { extensions: state.extensions } : {}),
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
        usageLog: "./usage.jsonl",
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

    // Matrix
    if (state.enableMatrix) {
        config.matrix = {
            homeserver: state.matrixHomeserver,
            user: state.matrixUser,
            token: state.matrixToken,
            channels: state.matrixRooms,
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

async function stepSession(): Promise<{ name: string; extensions: string[] }> {
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

    const extInput = guard(
        await p.text({
            message: "Pi extensions (comma-separated paths, or empty for none)",
            initialValue: "",
        }),
    );

    const extensions = extInput
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);

    return { name, extensions };
}

async function stepListeners(sessionName: string): Promise<{
    enableDiscord: boolean;
    discordToken?: string;
    discordChannels: Record<string, string>;
    enableMatrix: boolean;
    matrixHomeserver?: string;
    matrixUser?: string;
    matrixToken?: string;
    matrixRooms: Record<string, string>;
}> {
    const platforms = guard(
        await p.multiselect({
            message: "Chat platforms",
            options: [
                { value: "discord", label: "Discord" },
                { value: "matrix", label: "Matrix" },
            ],
            required: false,
        }),
    );

    let enableDiscord = platforms.includes("discord");
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

    let enableMatrix = platforms.includes("matrix");
    let matrixHomeserver: string | undefined;
    let matrixUser: string | undefined;
    let matrixToken: string | undefined;
    const matrixRooms: Record<string, string> = {};

    if (enableMatrix) {
        matrixHomeserver = guard(
            await p.text({
                message: "Matrix homeserver URL",
                placeholder: "https://matrix.example.org",
                validate: (v = "") => {
                    if (!v.trim()) return "Required";
                    return undefined;
                },
            }),
        );

        matrixUser = guard(
            await p.text({
                message: "Matrix bot user",
                placeholder: "@bot:example.org",
                validate: (v = "") => {
                    if (!v.trim()) return "Required";
                    return undefined;
                },
            }),
        );

        const envToken = process.env.MATRIX_TOKEN;
        if (envToken) {
            const useEnv = guard(
                await p.confirm({
                    message: `Found MATRIX_TOKEN in environment (${maskKey(envToken)}). Use it?`,
                    initialValue: true,
                }),
            );
            matrixToken = useEnv ? "env:MATRIX_TOKEN" : undefined;
        }

        if (!matrixToken) {
            matrixToken = guard(
                await p.text({
                    message: "Matrix access token",
                    validate: (v = "") => {
                        if (!v.trim()) return "Required";
                        return undefined;
                    },
                }),
            );
        }

        // Room mapping
        let addMore = true;
        while (addMore) {
            const roomId = guard(
                await p.text({
                    message: "Matrix room ID",
                    placeholder: "!room:example.org",
                    validate: (v = "") => {
                        if (!v.trim()) return "Required";
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

            matrixRooms[roomId] = targetSession;

            addMore = guard(
                await p.confirm({
                    message: "Add another room?",
                    initialValue: false,
                }),
            );
        }
    }

    return {
        enableDiscord,
        discordToken,
        discordChannels,
        enableMatrix,
        matrixHomeserver,
        matrixUser,
        matrixToken,
        matrixRooms,
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

async function stepSandbox(): Promise<{ enable: boolean; image: string }> {
    const enable = guard(
        await p.confirm({
            message: "Run in Docker sandbox? (isolates filesystem, nix available for deps)",
            initialValue: false,
        }),
    );

    if (!enable) return { enable: false, image: "" };

    const image = guard(
        await p.text({
            message: "Docker image",
            initialValue: "nest:latest",
        }),
    );

    return { enable, image };
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

    // 3. Seed plugins directory
    const pluginsDir = join(configDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });

    const pluginsToCopy: string[] = ["commands.ts", "dashboard.ts"];
    if (state.enableDiscord) pluginsToCopy.push("discord.ts");
    if (state.enableMatrix) pluginsToCopy.push("matrix.ts");
    if (state.enableServer) pluginsToCopy.push("webhook.ts");

    for (const plugin of pluginsToCopy) {
        const src = join(PLUGINS_SOURCE, plugin);
        const dest = join(pluginsDir, plugin);
        if (existsSync(src)) {
            if (!existsSync(dest)) {
                copyFileSync(src, dest);
                p.log.success(`Copied: plugins/${plugin}`);
            } else {
                p.log.info(`Exists: plugins/${plugin} (skipped)`);
            }
        } else {
            p.log.warn(`Not found: ${src}`);
        }
    }

    // 4. Create cron directory
    if (state.enableCron) {
        const cronDir = resolve(configDir, state.cronDir);
        mkdirSync(cronDir, { recursive: true });
        p.log.success(`Created: ${state.cronDir}/`);
    }

    // 5. Create usage log directory
    const usageDir = resolve(configDir);
    if (!existsSync(join(usageDir, "usage.jsonl"))) {
        writeFileSync(join(usageDir, "usage.jsonl"), "", "utf-8");
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
        extensions: session.extensions,
        ...listeners,
        enableServer: server.enable,
        serverPort: server.port,
        serverToken: server.token,
        enableCron: cron.enable,
        cronDir: cron.dir,
        enableSandbox: sandbox.enable,
        sandboxImage: sandbox.image,
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
    if (listeners.enableMatrix) {
        summaryLines.push(`Matrix:    ${Object.keys(listeners.matrixRooms).length} room(s)`);
    }
    if (server.enable) {
        summaryLines.push(`Server:    http://127.0.0.1:${server.port}`);
    }
    if (cron.enable) {
        summaryLines.push(`Cron:      ${cron.dir}`);
    }
    if (sandbox.enable) {
        summaryLines.push(`Sandbox:   Docker (${sandbox.image})`);
    } else {
        summaryLines.push(`Sandbox:   none (bare-metal)`);
    }

    p.note(summaryLines.join("\n"), "Setup complete");

    p.outro(`Start with: nest -w ${instanceName} start`);

    return { instanceName, nestDir };
}
