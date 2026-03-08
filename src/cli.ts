#!/usr/bin/env node
/**
 * nest — CLI entry point
 *
 * Commands:
 *   nest init [path]                    Create a new workspace (full setup wizard)
 *   nest start                          Start gateway (default if no command)
 *   nest attach                         Attach pi TUI to a running session
 *   nest status                         Show workspace info
 *   nest list                           List known workspaces
 *
 * Options:
 *   -w, --workspace <name|path>         Select workspace
 *   -s, --session <name>                Select session (for attach)
 *   -c, --config <path>                 Explicit config file
 *   -h, --help                          Show help
 *   -v, --version                       Show version
 */

import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const __srcDir = dirname(fileURLToPath(import.meta.url));

// ─── Workspace Registry ─────────────────────────────────────

const NEST_HOME = join(homedir(), ".nest");
const REGISTRY_PATH = join(NEST_HOME, "workspaces.json");

interface WorkspaceRegistry {
    workspaces: Record<string, string>; // name -> absolute path
    default?: string;
}

function loadRegistry(): WorkspaceRegistry {
    try {
        if (existsSync(REGISTRY_PATH)) {
            return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
        }
    } catch {}
    return { workspaces: {} };
}

function saveRegistry(registry: WorkspaceRegistry): void {
    mkdirSync(NEST_HOME, { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

export function registerWorkspace(name: string, path: string): void {
    const registry = loadRegistry();
    registry.workspaces[name] = resolve(path);
    if (!registry.default) {
        registry.default = name;
    }
    saveRegistry(registry);
}

function resolveWorkspace(nameOrPath?: string): { path: string; name?: string } | null {
    if (!nameOrPath) {
        // Try current directory first
        const cwd = process.cwd();
        if (existsSync(join(cwd, "config.yaml"))) {
            // Check if cwd matches a registered workspace
            const registry = loadRegistry();
            const resolvedCwd = resolve(cwd);
            const match = Object.entries(registry.workspaces).find(([, p]) => resolve(p) === resolvedCwd);
            return { path: cwd, name: match?.[0] };
        }

        // Try default workspace from registry
        const registry = loadRegistry();
        if (registry.default) {
            const p = registry.workspaces[registry.default];
            if (p && existsSync(join(p, "config.yaml"))) {
                return { path: p, name: registry.default };
            }
        }
        // Fallback: try ~/.nest/<name> for single-workspace setups
        const nestHome = join(homedir(), ".nest");
        if (existsSync(nestHome)) {
            try {
                const dirs = readdirSync(nestHome).filter(
                    (d) => existsSync(join(nestHome, d, "config.yaml")),
                );
                if (dirs.length === 1) {
                    return { path: join(nestHome, dirs[0]), name: dirs[0] };
                }
            } catch {}
        }
        return null;
    }

    // Check registry first
    const registry = loadRegistry();
    const registered = registry.workspaces[nameOrPath];
    if (registered && existsSync(join(registered, "config.yaml"))) {
        return { path: registered, name: nameOrPath };
    }

    // Try as ~/.nest/<name>
    const asNestDir = join(homedir(), ".nest", nameOrPath);
    if (existsSync(join(asNestDir, "config.yaml"))) {
        return { path: asNestDir, name: nameOrPath };
    }

    // Try as absolute/relative path
    const asPath = resolve(nameOrPath);
    if (existsSync(join(asPath, "config.yaml"))) {
        return { path: asPath };
    }

    return null;
}

// ─── Help ───────────────────────────────────────────────────

function printHelp(): void {
    console.log(`
  🪺 nest — minimal agent gateway

  Commands:
    nest init [path]                     Create a new workspace (setup wizard)
    nest start                           Start gateway
    nest attach                          Attach pi TUI to a session
    nest status                          Show workspace info
    nest list                            List known workspaces

  Options:
    -w, --workspace <name|path>          Select workspace
    -s, --session <name>                 Select session (for attach)
    -c, --config <path>                  Explicit config file path
    -h, --help                           Show this help
    -v, --version                        Show version

  Examples:
    nest init                            Create workspace (default: ~/.nest/<name>/)
    nest init wren                       Create workspace with name hint
    nest -w wren start                   Start named workspace
    nest -w wren attach                  Attach TUI to default session
    nest -w wren -s background attach    Attach TUI to specific session

  Workspaces:
    A workspace is a self-contained directory:
      ~/.nest/wren/
      ├── config.yaml
      ├── plugins/
      ├── cron.d/
      └── .pi/agent/    (models.json, sessions — isolated from ~/.pi/agent/)

    \`nest init\` runs the full setup wizard. Default location is ~/.nest/<name>/
    but you can choose any path. Registry at ~/.nest/workspaces.json maps
    names to paths.
`.trimEnd());
}

function printVersion(): void {
    try {
        const pkg = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
        );
        console.log(`nest ${pkg.version}`);
    } catch {
        console.log("nest (unknown version)");
    }
}

// ─── Arg Parsing ────────────────────────────────────────────

interface ParsedArgs {
    command: "init" | "start" | "stop" | "build" | "rebuild" | "attach" | "status" | "list" | "help" | "version";
    workspace?: string;
    session?: string;
    config?: string;
    rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
    const args = argv.slice(2);
    let command: ParsedArgs["command"] = "start";
    let workspace: string | undefined;
    let session: string | undefined;
    let config: string | undefined;
    const rest: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "init") {
            command = "init";
        } else if (arg === "start") {
            command = "start";
        } else if (arg === "stop") {
            command = "stop";
        } else if (arg === "build") {
            command = "build";
        } else if (arg === "rebuild") {
            command = "rebuild";
        } else if (arg === "attach") {
            command = "attach";
        } else if (arg === "status") {
            command = "status";
        } else if (arg === "list") {
            command = "list";
        } else if (arg === "--help" || arg === "-h") {
            command = "help";
        } else if (arg === "--version" || arg === "-v") {
            command = "version";
        } else if (arg === "--workspace" || arg === "-w") {
            workspace = args[++i];
        } else if (arg === "--session" || arg === "-s") {
            session = args[++i];
        } else if (arg === "--config" || arg === "-c") {
            config = args[++i];
        } else {
            rest.push(arg);
        }
    }

    return { command, workspace, session, config, rest };
}

// ─── Commands ───────────────────────────────────────────────

async function cmdInit(args: ParsedArgs): Promise<void> {
    const nameHint = args.rest[0];

    const { runInitWizard } = await import("./init.js");
    const result = await runInitWizard(nameHint);

    if (result) {
        registerWorkspace(result.instanceName, result.nestDir);
    }
}

async function cmdStart(args: ParsedArgs): Promise<void> {
    // Explicit --config: run bare-metal from that path (no workspace needed)
    if (args.config) {
        const configPath = resolve(args.config);
        if (!existsSync(configPath)) {
            console.error(`Error: config file not found: ${configPath}`);
            process.exit(1);
        }
        await startBareMetal({ path: dirname(configPath) }, configPath);
        return;
    }

    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found (no config.yaml in current directory)");
        console.error('Run "nest init" to create a workspace, or "nest list" to see known workspaces');
        process.exit(1);
    }

    const configPath = join(ws.path, "config.yaml");

    // Register workspace if not already known
    if (ws.name) {
        registerWorkspace(ws.name, ws.path);
    }

    // Sandbox mode: docker-compose.yml exists in workspace
    const composePath = join(ws.path, "docker-compose.yml");
    if (existsSync(composePath)) {
        await startSandboxed(ws);
    } else {
        await startBareMetal(ws, configPath);
    }
}

async function startSandboxed(
    ws: { path: string; name?: string },
): Promise<void> {
    console.log(`Starting sandboxed workspace "${ws.name ?? ws.path}"`);
    console.log(`  docker compose up -d --build`);
    console.log();

    const result = spawnSync("docker", ["compose", "-f", join(ws.path, "docker-compose.yml"), "up", "-d", "--build"], {
        stdio: "inherit",
        cwd: ws.path,
    });

    if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
            console.error("Error: docker not found. Install Docker to use sandbox mode.");
        } else {
            console.error(`Error: ${result.error.message}`);
        }
        process.exit(1);
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    console.log();
    console.log(`  nest stop -w ${ws.name ?? "..."}     Stop the container`);
    console.log(`  nest attach -w ${ws.name ?? "..."}   Attach TUI`);
}

function requireCompose(ws: { path: string; name?: string }): string {
    const composePath = join(ws.path, "docker-compose.yml");
    if (!existsSync(composePath)) {
        console.error("No docker-compose.yml found in workspace.");
        console.error('Run "nest init" with sandbox enabled to generate Docker files.');
        process.exit(1);
    }
    return composePath;
}

function composeExec(composePath: string, ...composeArgs: string[]): void {
    const result = spawnSync("docker", ["compose", "-f", composePath, ...composeArgs], {
        stdio: "inherit",
        cwd: dirname(composePath),
    });

    if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
            console.error("Error: docker not found. Install Docker to use sandbox mode.");
        } else {
            console.error(`Error: ${result.error.message}`);
        }
        process.exit(1);
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

async function cmdStop(args: ParsedArgs): Promise<void> {
    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found");
        process.exit(1);
    }

    const composePath = requireCompose(ws);
    console.log(`Stopping workspace "${ws.name ?? ws.path}"...`);
    composeExec(composePath, "down");
    console.log("Stopped.");
}

async function cmdBuild(args: ParsedArgs): Promise<void> {
    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found");
        process.exit(1);
    }

    const composePath = requireCompose(ws);
    console.log(`Building workspace "${ws.name ?? ws.path}"...`);
    composeExec(composePath, "build");
}

async function cmdRebuild(args: ParsedArgs): Promise<void> {
    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found");
        process.exit(1);
    }

    const composePath = requireCompose(ws);
    console.log(`Rebuilding workspace "${ws.name ?? ws.path}"...`);
    composeExec(composePath, "down");
    composeExec(composePath, "up", "-d", "--build");
}

async function startBareMetal(
    ws: { path: string; name?: string },
    configPath: string,
): Promise<void> {
    process.chdir(ws.path);

    if (ws.name) {
        console.log(`Starting workspace "${ws.name}" (${ws.path})`);
    }

    const { loadConfig } = await import("./config.js");
    const { Kernel } = await import("./kernel.js");
    const { Bridge } = await import("./bridge.js");
    const { SessionManager } = await import("./session-manager.js");
    const logger = await import("./logger.js");

    const config = loadConfig(configPath);

    // Extensions and session-dir are handled by SessionManager.startSession().
    // The factory just sets up the basic bridge with agentDir env if needed.
    function createBridge(opts: { cwd: string; command?: string; args?: string[] }) {
        const sessionConfig = Object.values(config.sessions).find(
            (s) => s.pi.cwd === opts.cwd,
        );
        const agentDir = sessionConfig?.pi.agentDir ?? config.instance?.agentDir;
        const env: Record<string, string> = {};
        if (agentDir) {
            env.PI_CODING_AGENT_DIR = resolve(agentDir);
        }

        return new Bridge({
            cwd: opts.cwd,
            command: opts.command,
            args: opts.args ?? ["--mode", "rpc", "--continue"],
            ...(Object.keys(env).length > 0 ? { env } : {}),
        });
    }

    const sessionManager = new SessionManager(config, createBridge);
    const kernel = new Kernel(config, sessionManager);

    const shutdown = () => {
        kernel.stop().then(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    kernel.start().catch((err) => {
        logger.error("Failed to start", { error: String(err) });
        process.exit(1);
    });
}

async function cmdAttach(args: ParsedArgs): Promise<void> {
    const workspace = resolveWorkspace(args.workspace);
    if (!workspace) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found");
        console.error('Run "nest list" to see known workspaces');
        process.exit(1);
    }

    const { loadConfigRaw } = await import("./config.js");
    const configPath = join(workspace.path, "config.yaml");
    const config = loadConfigRaw(configPath);

    if (!config.server) {
        console.error("Error: no server configured — nest attach requires server.port and server.token");
        process.exit(1);
    }

    const port = config.server.port;
    const host = config.attach?.host ?? "127.0.0.1";
    const token = process.env.SERVER_TOKEN ?? config.server.token;
    const username = process.env.USER ?? "cli";

    // Resolve token from .env file if it's an env: reference
    let resolvedToken = token;
    if (typeof token === "string" && token.startsWith("env:")) {
        const envName = token.slice(4);
        resolvedToken = process.env[envName] ?? "";
        if (!resolvedToken) {
            // Try loading from .env in workspace
            const envPath = join(workspace.path, ".env");
            if (existsSync(envPath)) {
                const envFile = readFileSync(envPath, "utf-8");
                const match = envFile.match(new RegExp(`^${envName}=(.+)$`, "m"));
                if (match) resolvedToken = match[1].trim().replace(/^["']|["']$/g, "");
            }
        }
        if (!resolvedToken) {
            console.error(`Error: environment variable ${envName} not set`);
            process.exit(1);
        }
    }

    const wsUrl = `ws://${host}:${port}/cli`;
    console.log(`Connecting to ${wsUrl}...`);

    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", token: resolvedToken, username }));
    });

    ws.on("message", (rawData) => {
        let msg: any;
        try { msg = JSON.parse(rawData.toString()); } catch { return; }

        if (msg.type === "auth_ok") {
            // Auth succeeded — hand off to TUI
            import("./attach-tui.js").then(({ startTui }) => {
                startTui(ws, workspace.name ?? "nest");
            });
        } else if (msg.type === "auth_fail") {
            console.error("Authentication failed");
            process.exit(1);
        }
    });

    ws.on("close", () => {
        console.error("Connection closed before auth");
        process.exit(1);
    });

    ws.on("error", (err) => {
        console.error(`Failed to connect to ${wsUrl}`);
        console.error("Is the nest server running?");
        process.exit(1);
    });
}

async function cmdStatus(args: ParsedArgs): Promise<void> {
    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found");
        process.exit(1);
    }

    const { loadConfigRaw } = await import("./config.js");
    const config = loadConfigRaw(join(ws.path, "config.yaml"));

    const sessions = Object.keys(config.sessions);
    const agentDir = config.instance?.agentDir
        ? resolve(ws.path, config.instance.agentDir)
        : "~/.pi/agent (shared)";
    const pluginsRel = config.instance?.pluginsDir ?? "./plugins";
    const pluginsDir = resolve(ws.path, pluginsRel);

    let pluginCount = 0;
    if (existsSync(pluginsDir)) {
        pluginCount = readdirSync(pluginsDir).filter(
            (f) => f.endsWith(".ts") || existsSync(join(pluginsDir, f, "index.ts")),
        ).length;
    }

    const cronDir = config.cron?.dir ? resolve(ws.path, config.cron.dir) : null;
    let cronCount = 0;
    if (cronDir && existsSync(cronDir)) {
        cronCount = readdirSync(cronDir).filter((f) => f.endsWith(".md")).length;
    }

    const listeners = [
        config.discord ? "Discord" : null,
        config.matrix ? "Matrix" : null,
    ].filter(Boolean);

    console.log(`
  🪺 nest workspace${ws.name ? `: ${ws.name}` : ""}
  ${ws.path}

  Instance:    ${config.instance?.name ?? "nest"}
  Agent dir:   ${agentDir}
  Sessions:    ${sessions.join(", ")} (default: ${config.defaultSession})
  Plugins:     ${pluginCount} in ${pluginsRel}
  Server:      ${config.server ? `http://${config.server.host ?? "127.0.0.1"}:${config.server.port}` : "disabled"}
  Cron:        ${cronDir ? `${cronCount} job(s) in ${config.cron!.dir}` : "disabled"}
  Listeners:   ${listeners.length > 0 ? listeners.join(", ") : "none"}
`.trimEnd());
    console.log();
}

async function cmdList(): Promise<void> {
    const registry = loadRegistry();
    const names = Object.keys(registry.workspaces);

    if (names.length === 0) {
        console.log("\n  No workspaces registered.");
        console.log('  Run "nest init" to create one.\n');
        return;
    }

    console.log("\n  🪺 nest workspaces\n");
    for (const name of names.sort()) {
        const wsPath = registry.workspaces[name];
        const exists = existsSync(join(wsPath, "config.yaml"));
        const isDefault = name === registry.default;
        const marker = isDefault ? " (default)" : "";
        const status = exists ? "✓" : "✗ missing";
        console.log(`  ${status}  ${name}${marker}`);
        console.log(`      ${wsPath}`);
    }
    console.log();
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv);

    switch (args.command) {
        case "help":
            printHelp();
            break;
        case "version":
            printVersion();
            break;
        case "init":
            await cmdInit(args);
            break;
        case "start":
            await cmdStart(args);
            break;
        case "stop":
            await cmdStop(args);
            break;
        case "build":
            await cmdBuild(args);
            break;
        case "rebuild":
            await cmdRebuild(args);
            break;
        case "attach":
            await cmdAttach(args);
            break;
        case "status":
            await cmdStatus(args);
            break;
        case "list":
            await cmdList();
            break;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
