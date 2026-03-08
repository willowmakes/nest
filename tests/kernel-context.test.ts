import { describe, it, expect, vi, beforeEach } from "vitest";
import { Kernel } from "../src/kernel.js";
import { SessionManager } from "../src/session-manager.js";
import { MockListener } from "./helpers.js";
import type { Config } from "../src/types.js";

function makeConfig(overrides?: Partial<Config>): Config {
    return {
        instance: {
            name: "test-nest",
            pluginsDir: "/app/plugins",
        },
        sessions: {
            default: { pi: { cwd: "/tmp" } },
        },
        defaultSession: "default",
        ...overrides,
    };
}

function makeMockBridge() {
    return {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        busy: false,
        sendMessage: vi.fn().mockResolvedValue("response"),
    } as any;
}

describe("Kernel.buildNestContext", () => {
    it("includes instance name and session", () => {
        const config = makeConfig();
        const sm = new SessionManager(config, () => makeMockBridge());
        const kernel = new Kernel(config, sm);

        const ctx = kernel.buildNestContext();
        expect(ctx).toContain("test-nest");
        expect(ctx).toContain("default");
        expect(ctx).toContain("## Nest Environment");
    });

    it("includes listener info after attachment", () => {
        const config = makeConfig();
        const sm = new SessionManager(config, () => makeMockBridge());
        const listener = new MockListener("discord");
        sm.attach("default", listener, { platform: "discord", channel: "general" });

        const kernel = new Kernel(config, sm);
        const ctx = kernel.buildNestContext();
        expect(ctx).toContain("discord");
        expect(ctx).toContain("general");
    });

    it("includes doc path pointers", () => {
        const config = makeConfig();
        const sm = new SessionManager(config, () => makeMockBridge());
        const kernel = new Kernel(config, sm);

        const ctx = kernel.buildNestContext();
        expect(ctx).toContain("types.ts");
        expect(ctx).toContain("README.md");
        expect(ctx).toContain("pi.ts");
        expect(ctx).toContain("nest.ts");
    });

    it("includes registered commands", () => {
        const config = makeConfig();
        const sm = new SessionManager(config, () => makeMockBridge());
        const kernel = new Kernel(config, sm);

        // Core commands are registered in constructor
        const ctx = kernel.buildNestContext();
        expect(ctx).toContain("status");
        expect(ctx).toContain("reboot");
    });
});
