import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { MockListener, makeMessage } from "./helpers.js";
import type { Config } from "../src/types.js";

function makeConfig(overrides?: Partial<Config>): Config {
    return {
        sessions: {
            main: { pi: { cwd: "/tmp" } },
            background: { pi: { cwd: "/tmp" } },
        },
        defaultSession: "main",
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
        command: vi.fn().mockResolvedValue({}),
        emit: vi.fn(),
    } as any;
}

describe("SessionManager", () => {
    let sm: SessionManager;
    let mockBridge: any;

    beforeEach(() => {
        mockBridge = makeMockBridge();
        sm = new SessionManager(makeConfig(), () => mockBridge);
    });

    it("lists configured sessions", () => {
        expect(sm.getSessionNames()).toEqual(["main", "background"]);
    });

    it("returns default session name", () => {
        expect(sm.getDefaultSessionName()).toBe("main");
    });

    it("starts a session lazily", async () => {
        const bridge = await sm.getOrStartSession("main");
        expect(bridge).toBe(mockBridge);
        expect(mockBridge.start).toHaveBeenCalled();
    });

    it("throws for unknown session", async () => {
        await expect(sm.getOrStartSession("unknown")).rejects.toThrow("Unknown session");
    });

    describe("attach/detach", () => {
        it("attaches a listener to a session", () => {
            const listener = new MockListener("discord");
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            const bindings = sm.getListeners("main");
            expect(bindings).toHaveLength(1);
            expect(bindings[0].listener.name).toBe("discord");
            expect(bindings[0].origin.channel).toBe("123");
        });

        it("prevents duplicate attachments", () => {
            const listener = new MockListener("discord");
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            expect(sm.getListeners("main")).toHaveLength(1);
        });

        it("allows same listener on different channels", () => {
            const listener = new MockListener("discord");
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            sm.attach("main", listener, { platform: "discord", channel: "456" });
            expect(sm.getListeners("main")).toHaveLength(2);
        });

        it("detaches a listener", () => {
            const listener = new MockListener("discord");
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            sm.detach("main", listener);
            expect(sm.getListeners("main")).toHaveLength(0);
        });

        it("throws when attaching to unknown session", () => {
            const listener = new MockListener();
            expect(() => sm.attach("unknown", listener, { platform: "test", channel: "x" }))
                .toThrow("Unknown session");
        });
    });

    describe("nestContext", () => {
        it("appends --append-system-prompt when builder is set", async () => {
            const capturedArgs: any[] = [];
            const sm2 = new SessionManager(makeConfig(), (opts) => {
                capturedArgs.push(opts);
                return makeMockBridge();
            });
            sm2.setNestContextBuilder(() => "## Nest Environment\ntest context");
            await sm2.getOrStartSession("main");
            expect(capturedArgs).toHaveLength(1);
            const bridgeArgs = capturedArgs[0].args as string[];
            const idx = bridgeArgs.indexOf("--append-system-prompt");
            expect(idx).toBeGreaterThan(-1);
            expect(bridgeArgs[idx + 1]).toContain("## Nest Environment");
        });

        it("rebuilds context on each session start", async () => {
            let callCount = 0;
            const capturedArgs: any[] = [];
            const sm2 = new SessionManager(makeConfig(), (opts) => {
                capturedArgs.push(opts);
                return makeMockBridge();
            });
            sm2.setNestContextBuilder(() => `context-${++callCount}`);
            await sm2.getOrStartSession("main");
            // Stop and restart to verify rebuild
            await sm2.stopSession("main");
            await sm2.getOrStartSession("main");
            expect(callCount).toBe(2);
            const args1 = capturedArgs[0].args as string[];
            const args2 = capturedArgs[1].args as string[];
            expect(args1[args1.indexOf("--append-system-prompt") + 1]).toContain("context-1");
            expect(args2[args2.indexOf("--append-system-prompt") + 1]).toContain("context-2");
        });

        it("concatenates with existing --append-system-prompt", async () => {
            const config = makeConfig({
                sessions: {
                    main: { pi: { cwd: "/tmp", args: ["--mode", "rpc", "--append-system-prompt", "existing context"] } },
                    background: { pi: { cwd: "/tmp" } },
                },
            });
            const capturedArgs: any[] = [];
            const sm2 = new SessionManager(config, (opts) => {
                capturedArgs.push(opts);
                return makeMockBridge();
            });
            sm2.setNestContextBuilder(() => "nest addition");
            await sm2.getOrStartSession("main");
            const bridgeArgs = capturedArgs[0].args as string[];
            const idx = bridgeArgs.indexOf("--append-system-prompt");
            expect(bridgeArgs[idx + 1]).toContain("existing context");
            expect(bridgeArgs[idx + 1]).toContain("nest addition");
        });

        it("skips prompt injection when no builder set", async () => {
            const capturedArgs: any[] = [];
            const sm2 = new SessionManager(makeConfig(), (opts) => {
                capturedArgs.push(opts);
                return makeMockBridge();
            });
            await sm2.getOrStartSession("main");
            const bridgeArgs = capturedArgs[0].args as string[];
            expect(bridgeArgs).not.toContain("--append-system-prompt");
        });

        it("discovers pi.ts extensions from plugin directories", async () => {
            const config = makeConfig({
                sessions: {
                    main: { pi: { cwd: "/tmp", extensions: ["/custom/ext.ts"] } },
                },
            });
            const capturedArgs: any[] = [];
            const sm2 = new SessionManager(config, (opts) => {
                capturedArgs.push(opts);
                return makeMockBridge();
            });
            await sm2.getOrStartSession("main");
            const bridgeArgs = capturedArgs[0].args as string[];
            // Find all -e flags
            const extPaths: string[] = [];
            for (let i = 0; i < bridgeArgs.length; i++) {
                if (bridgeArgs[i] === "-e") extPaths.push(bridgeArgs[i + 1]);
            }
            // Should include auto-discovered pi.ts files from plugins/ + the explicit one
            expect(extPaths.length).toBeGreaterThanOrEqual(1);
            expect(extPaths).toContain("/custom/ext.ts");
        });
    });

    describe("broadcast", () => {
        it("sends to all attached listeners", async () => {
            const l1 = new MockListener("discord");
            const l2 = new MockListener("cli");
            sm.attach("main", l1, { platform: "discord", channel: "123" });
            sm.attach("main", l2, { platform: "cli", channel: "tty" });

            await sm.broadcast("main", "hello everyone");
            expect(l1.sent).toHaveLength(1);
            expect(l1.sent[0].text).toBe("hello everyone");
            expect(l2.sent).toHaveLength(1);
            expect(l2.sent[0].text).toBe("hello everyone");
        });

        it("sends nothing if no listeners", async () => {
            await sm.broadcast("main", "nobody here");
            // No error thrown
        });

        it("only sends stream events to listeners with streaming enabled", async () => {
            const streaming = new MockListener("cli", true);
            const nonStreaming = new MockListener("discord");
            sm.attach("main", streaming, { platform: "cli", channel: "tty" });
            sm.attach("main", nonStreaming, { platform: "discord", channel: "123" });

            await sm.broadcast("main", "delta", undefined, undefined, "stream");
            expect(streaming.sent).toHaveLength(1);
            expect(nonStreaming.sent).toHaveLength(0);

            // Final text goes to both
            await sm.broadcast("main", "full response", undefined, undefined, "text");
            expect(streaming.sent).toHaveLength(2);
            expect(nonStreaming.sent).toHaveLength(1);
        });
    });
});
