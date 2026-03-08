import { describe, it, expect, vi, afterAll } from "vitest";
import { loadPlugins } from "../src/plugin-loader.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NestAPI } from "../src/types.js";

const TMP = join(import.meta.dirname ?? ".", ".test-plugins-tmp");

function makeAPI(): NestAPI {
    return {
        registerListener: vi.fn(),
        registerMiddleware: vi.fn(),
        registerCommand: vi.fn(),
        registerRoute: vi.fn(),
        registerPrefixRoute: vi.fn(),
        on: vi.fn(),
        sessions: {
            get: vi.fn(),
            getOrStart: vi.fn(),
            stop: vi.fn(),
            list: vi.fn().mockReturnValue([]),
            getDefault: vi.fn().mockReturnValue("main"),
            recordActivity: vi.fn(),
            attach: vi.fn(),
            detach: vi.fn(),
            getListeners: vi.fn().mockReturnValue([]),
        },
        tracker: {
            record: vi.fn(),
            today: vi.fn(),
            todayBySession: vi.fn(),
            week: vi.fn(),
            currentModel: vi.fn(),
            currentContext: vi.fn(),
        },
        config: { sessions: {}, defaultSession: "main" } as any,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        instance: { name: "test", dataDir: "." },
    };
}

describe("loadPlugins", () => {
    it("returns empty array when directory doesn't exist", async () => {
        const api = makeAPI();
        const loaded = await loadPlugins("/nonexistent/path", api);
        expect(loaded).toEqual([]);
    });

    it("loads .ts files from a directory", async () => {
        const dir = join(TMP, "basic");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "test-plugin.ts"), `
            export default function(nest) {
                nest.registerCommand("test", { execute: async () => {} });
            }
        `);

        const api = makeAPI();
        const loaded = await loadPlugins(dir, api);
        expect(loaded).toContain("test-plugin");
        expect(api.registerCommand).toHaveBeenCalledWith("test", expect.any(Object));
    });

    it("loads directory plugins with nest.ts", async () => {
        const dir = join(TMP, "dirplugin");
        const pluginDir = join(dir, "my-plugin");
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(pluginDir, "nest.ts"), `
            export default function(nest) {
                nest.registerMiddleware({ name: "test-mw", process: async (m) => m });
            }
        `);

        const api = makeAPI();
        const loaded = await loadPlugins(dir, api);
        expect(loaded).toContain("my-plugin");
        expect(api.registerMiddleware).toHaveBeenCalled();
    });

    it("skips files without default export function", async () => {
        const dir = join(TMP, "nodefault");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "bad.ts"), `export const x = 1;`);

        const api = makeAPI();
        const loaded = await loadPlugins(dir, api);
        expect(loaded).toEqual([]);
    });

    afterAll(() => {
        try { rmSync(TMP, { recursive: true }); } catch {}
    });
});
