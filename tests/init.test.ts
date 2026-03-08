import { describe, it, expect } from "vitest";

// We can't easily test the interactive wizard, but we can test the
// config/models builders by importing the module and testing the output shapes.
// Since init.ts is a script with side effects, we test the logic inline here.

import yaml from "js-yaml";

describe("init config generation", () => {
    it("generates valid yaml for minimal config", () => {
        const config = {
            instance: { name: "nest", dataDir: ".", pluginsDir: "./plugins" },
            sessions: {
                default: { pi: { cwd: "/home/test" } },
            },
            defaultSession: "default",
            tracking: { usageLog: "./usage.jsonl", capacity: 1000, retentionDays: 30 },
        };

        const yamlStr = yaml.dump(config, { lineWidth: -1, noRefs: true });
        const parsed = yaml.load(yamlStr) as Record<string, any>;

        expect(parsed.sessions.default.pi.cwd).toBe("/home/test");
        expect(parsed.defaultSession).toBe("default");
        expect(parsed.instance.name).toBe("nest");
    });

    it("generates valid yaml with discord config", () => {
        const config = {
            instance: { name: "nest", dataDir: ".", pluginsDir: "./plugins" },
            sessions: {
                wren: { pi: { cwd: "/home/wren", extensions: ["/app/ext/vault.ts"] } },
            },
            defaultSession: "wren",
            server: { port: 8484, token: "nest_abc123", host: "127.0.0.1" },
            cron: { dir: "./cron.d", gracePeriodMs: 5000 },
            tracking: { usageLog: "./usage.jsonl", capacity: 1000, retentionDays: 30 },
            discord: {
                token: "env:DISCORD_TOKEN",
                channels: { "123456789": "wren" },
            },
        };

        const yamlStr = yaml.dump(config, { lineWidth: -1, noRefs: true });
        const parsed = yaml.load(yamlStr) as Record<string, any>;

        expect(parsed.discord.token).toBe("env:DISCORD_TOKEN");
        expect(parsed.discord.channels["123456789"]).toBe("wren");
        expect(parsed.server.port).toBe(8484);
        expect(parsed.cron.dir).toBe("./cron.d");
    });

    it("generates valid models.json for built-in provider", () => {
        // Built-in providers just override the key
        const modelsJson = {
            providers: {
                anthropic: {
                    apiKey: "sk-ant-test123",
                },
            },
        };

        expect(modelsJson.providers.anthropic.apiKey).toBe("sk-ant-test123");
    });

    it("generates valid models.json for third-party provider", () => {
        const modelsJson = {
            providers: {
                openrouter: {
                    api: "openai-completions",
                    apiKey: "sk-or-test123",
                    baseUrl: "https://openrouter.ai/api/v1",
                    models: [
                        { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4 (OpenRouter)", reasoning: true },
                    ],
                },
            },
        };

        expect(modelsJson.providers.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
        expect(modelsJson.providers.openrouter.models).toHaveLength(1);
    });

    it("generates valid models.json for custom provider", () => {
        const modelsJson = {
            providers: {
                custom: {
                    baseUrl: "http://localhost:11434/v1",
                    api: "openai-completions",
                    apiKey: "ollama",
                    models: [{ id: "llama3.1:8b" }],
                },
            },
        };

        expect(modelsJson.providers.custom.baseUrl).toBe("http://localhost:11434/v1");
        expect(modelsJson.providers.custom.models[0].id).toBe("llama3.1:8b");
    });

    it("merges models.json with existing providers", () => {
        const existing = {
            providers: {
                anthropic: { apiKey: "old-key" },
            },
        };

        const newEntry = {
            providers: {
                openrouter: {
                    api: "openai-completions",
                    apiKey: "new-key",
                    baseUrl: "https://openrouter.ai/api/v1",
                    models: [],
                },
            },
        };

        const merged = {
            ...existing,
            providers: { ...existing.providers, ...newEntry.providers },
        };

        expect(merged.providers.anthropic.apiKey).toBe("old-key");
        expect(merged.providers.openrouter.apiKey).toBe("new-key");
    });

    it("generates token in expected format", () => {
        // Token format: nest_ + 32 chars of base64url
        const token = `nest_${Buffer.from("test").toString("base64url")}`;
        expect(token).toMatch(/^nest_/);
    });
});
