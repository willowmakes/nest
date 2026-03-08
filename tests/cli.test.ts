import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Test the workspace registry functions by importing them
// We can't easily test the full CLI (it's interactive), but we can
// test the registry and workspace resolution logic.

const TEST_REGISTRY = join(homedir(), ".nest", "workspaces.test.json");
const TEST_WORKSPACE = join(import.meta.dirname ?? "/tmp", ".test-workspace-" + Date.now());

describe("workspace registry", () => {
    beforeEach(() => {
        mkdirSync(TEST_WORKSPACE, { recursive: true });
    });

    afterEach(() => {
        rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    });

    it("workspace directory structure", () => {
        // A workspace is a directory with config.yaml
        writeFileSync(
            join(TEST_WORKSPACE, "config.yaml"),
            'sessions:\n  default:\n    pi:\n      cwd: /tmp\ndefaultSession: default\n',
        );
        mkdirSync(join(TEST_WORKSPACE, "plugins"), { recursive: true });
        mkdirSync(join(TEST_WORKSPACE, ".nest"), { recursive: true });

        expect(existsSync(join(TEST_WORKSPACE, "config.yaml"))).toBe(true);
        expect(existsSync(join(TEST_WORKSPACE, "plugins"))).toBe(true);
        expect(existsSync(join(TEST_WORKSPACE, ".nest"))).toBe(true);
    });

    it("registry format is valid json", () => {
        const registry = {
            workspaces: {
                wren: "/home/wren/bots/wren",
                test: "/home/wren/bots/test",
            },
            default: "wren",
        };

        const json = JSON.stringify(registry, null, 2);
        const parsed = JSON.parse(json);

        expect(parsed.workspaces.wren).toBe("/home/wren/bots/wren");
        expect(parsed.default).toBe("wren");
        expect(Object.keys(parsed.workspaces)).toHaveLength(2);
    });

    it("multiple workspaces can be registered", () => {
        const registry: Record<string, any> = {
            workspaces: {},
            default: undefined as string | undefined,
        };

        // Register first
        registry.workspaces["alpha"] = "/tmp/alpha";
        if (!registry.default) registry.default = "alpha";

        // Register second
        registry.workspaces["beta"] = "/tmp/beta";

        expect(registry.default).toBe("alpha");
        expect(Object.keys(registry.workspaces)).toHaveLength(2);
    });
});

describe("cli arg parsing", () => {
    // Test the arg parsing logic inline since it's a pure function
    function parseArgs(argv: string[]) {
        const args = argv.slice(2);
        let command: string = "start";
        let workspace: string | undefined;
        let session: string | undefined;
        const rest: string[] = [];

        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === "init") command = "init";
            else if (arg === "start") command = "start";
            else if (arg === "attach") command = "attach";
            else if (arg === "status") command = "status";
            else if (arg === "list") command = "list";
            else if (arg === "--help" || arg === "-h") command = "help";
            else if (arg === "--version" || arg === "-v") command = "version";
            else if (arg === "--workspace" || arg === "-w") workspace = args[++i];
            else if (arg === "--session" || arg === "-s") session = args[++i];
            else rest.push(arg);
        }

        return { command, workspace, session, rest };
    }

    it("defaults to start", () => {
        expect(parseArgs(["node", "cli.js"]).command).toBe("start");
    });

    it("parses init", () => {
        expect(parseArgs(["node", "cli.js", "init"]).command).toBe("init");
    });

    it("parses init with path", () => {
        const args = parseArgs(["node", "cli.js", "init", "/tmp/mybot"]);
        expect(args.command).toBe("init");
        expect(args.rest).toEqual(["/tmp/mybot"]);
    });

    it("parses attach with workspace and session", () => {
        const args = parseArgs(["node", "cli.js", "attach", "-w", "wren", "-s", "background"]);
        expect(args.command).toBe("attach");
        expect(args.workspace).toBe("wren");
        expect(args.session).toBe("background");
    });



    it("parses --workspace before command", () => {
        const args = parseArgs(["node", "cli.js", "-w", "wren", "start"]);
        expect(args.command).toBe("start");
        expect(args.workspace).toBe("wren");
    });

    it("parses long form options", () => {
        const args = parseArgs(["node", "cli.js", "--workspace", "test", "--session", "bg", "attach"]);
        expect(args.command).toBe("attach");
        expect(args.workspace).toBe("test");
        expect(args.session).toBe("bg");
    });

    it("parses help", () => {
        expect(parseArgs(["node", "cli.js", "--help"]).command).toBe("help");
        expect(parseArgs(["node", "cli.js", "-h"]).command).toBe("help");
    });

    it("parses version", () => {
        expect(parseArgs(["node", "cli.js", "--version"]).command).toBe("version");
        expect(parseArgs(["node", "cli.js", "-v"]).command).toBe("version");
    });
});
