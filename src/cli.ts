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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

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
    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found (no config.yaml in current directory)");
        console.error('Run "nest init" to create a workspace, or "nest list" to see known workspaces');
        process.exit(1);
    }

    const configPath = args.config ?? join(ws.path, "config.yaml");

    // Peek at config to check sandbox mode
    const { loadConfig } = await import("./config.js");
    const config = loadConfig(configPath);

    if (config.instance?.sandbox?.enabled) {
        await startSandboxed(ws, config);
    } else {
        await startBareMetal(ws, configPath);
    }
}

async function startSandboxed(
    ws: { path: string; name?: string },
    config: import("./types.js").Config,
): Promise<void> {
    const sandbox = config.instance!.sandbox!;
    const image = sandbox.image ?? "nest:latest";
    const containerName = `nest-${config.instance?.name ?? "default"}`;

    console.log(`Starting sandboxed workspace "${ws.name ?? ws.path}"`);
    console.log(`  Image:     ${image}`);
    console.log(`  Container: ${containerName}`);
    console.log(`  Workspace: ${ws.path}`);
    console.log();

    const dockerArgs = [
        "run", "-d",
        "--name", containerName,
        "--restart", "unless-stopped",

        // ── Workspace as HOME ──────────────────────────────
        // The workspace IS the agent's home directory.
        // Everything lives here: config, plugins, .pi/agent/, cron.d/
        "-v", `${ws.path}:/home/nest`,
        "-e", "HOME=/home/nest",
        "-e", "PI_CODING_AGENT_DIR=/home/nest/.pi/agent",
        "-w", "/home/nest",

        // ── Persistent nix store ───────────────────────────
        // Agent-installed nix packages survive container rebuilds.
        // Defaults to ~/.nest/nix/<name>/ to avoid being a subfolder of the workspace mount.
        "-v", `${resolve(sandbox.nixStore ?? join(homedir(), ".nest", "nix", config.instance?.name ?? "default"))}:/nix`,

        // ── Networking ─────────────────────────────────────
        `--network=${sandbox.network ?? "host"}`,
    ];

    // DNS
    if (sandbox.dns) {
        for (const server of sandbox.dns) {
            dockerArgs.push("--dns", server);
        }
    }

    // Port forwarding (only if not host networking)
    if (sandbox.network && sandbox.network !== "host") {
        // Expose configured ports
        if (sandbox.expose) {
            for (const port of sandbox.expose) {
                dockerArgs.push("-p", `${port}:${port}`);
            }
        }
        // Auto-expose server port
        if (config.server) {
            const port = config.server.port;
            const host = config.server.host ?? "127.0.0.1";
            dockerArgs.push("-p", `${host}:${port}:${port}`);
        }
    }

    // ── Filesystem ─────────────────────────────────────────
    if (sandbox.readOnly) {
        dockerArgs.push("--read-only");
    }

    if (sandbox.tmpfs) {
        for (const t of sandbox.tmpfs) {
            dockerArgs.push("--tmpfs", t);
        }
    } else if (sandbox.readOnly) {
        // Default tmpfs when read-only so nix/node can still work
        dockerArgs.push("--tmpfs", "/tmp:size=1g");
        dockerArgs.push("--tmpfs", "/run:size=64m");
    }

    // Extra bind mounts
    if (sandbox.mounts) {
        for (const mount of sandbox.mounts) {
            dockerArgs.push("-v", mount);
        }
    }

    // ── User & Permissions ─────────────────────────────────
    if (sandbox.user) {
        dockerArgs.push("--user", sandbox.user);
    }

    // Capabilities: drop all by default, add back what's needed
    if (sandbox.capDrop) {
        for (const cap of sandbox.capDrop) {
            dockerArgs.push("--cap-drop", cap);
        }
    }
    if (sandbox.capAdd) {
        for (const cap of sandbox.capAdd) {
            dockerArgs.push("--cap-add", cap);
        }
    }

    // ── Resource Limits ────────────────────────────────────
    if (sandbox.memory) {
        dockerArgs.push("--memory", sandbox.memory);
    }
    if (sandbox.cpus) {
        dockerArgs.push("--cpus", sandbox.cpus);
    }
    if (sandbox.pidsLimit) {
        dockerArgs.push("--pids-limit", String(sandbox.pidsLimit));
    }

    // ── Security ───────────────────────────────────────────
    if (sandbox.noNewPrivileges !== false) {
        dockerArgs.push("--security-opt", "no-new-privileges");
    }
    if (sandbox.seccomp) {
        dockerArgs.push("--security-opt", `seccomp=${sandbox.seccomp}`);
    }
    if (sandbox.apparmor) {
        dockerArgs.push("--security-opt", `apparmor=${sandbox.apparmor}`);
    }

    // ── Environment ────────────────────────────────────────
    if (sandbox.env) {
        for (const [key, val] of Object.entries(sandbox.env)) {
            dockerArgs.push("-e", `${key}=${val}`);
        }
    }

    // ── Raw args ───────────────────────────────────────────
    if (sandbox.args) {
        dockerArgs.push(...sandbox.args);
    }

    // ── Check for existing container ──────────────────────────
    try {
        const check = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
            encoding: "utf-8",
        });
        if (check.status === 0) {
            const status = check.stdout.trim();
            if (status === "running") {
                console.log(`Container "${containerName}" is already running.`);
                console.log(`Use "nest stop -w ${ws.name ?? ws.path}" to stop it, or "nest attach" to connect.`);
                process.exit(0);
            }
            // Remove stopped/dead container before re-creating
            spawnSync("docker", ["rm", containerName]);
        }
    } catch { /* docker not found — will fail below */ }

    // ── Image & Command ────────────────────────────────────
    dockerArgs.push(image, "node", "dist/cli.js", "start", "--config", "/home/nest/config.yaml");

    const result = spawnSync("docker", dockerArgs, { encoding: "utf-8" });

    if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
            console.error("Error: docker not found. Install Docker to use sandbox mode.");
        } else {
            console.error(`Error: ${result.error.message}`);
        }
        process.exit(1);
    }

    if (result.status !== 0) {
        console.error(result.stderr);
        process.exit(1);
    }

    console.log(`Container started: ${containerName}`);
    console.log(`  Restart policy: unless-stopped (survives reboots)`);
    console.log();
    console.log(`  nest stop -w ${ws.name ?? "..."}     Stop the container`);
    console.log(`  nest attach -w ${ws.name ?? "..."}   Attach TUI`);
    console.log(`  docker logs -f ${containerName}      Follow logs`);
}

async function cmdStop(args: ParsedArgs): Promise<void> {
    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found");
        process.exit(1);
    }

    const { loadConfig } = await import("./config.js");
    const configPath = join(ws.path, "config.yaml");
    const config = loadConfig(configPath);

    if (!config.instance?.sandbox?.enabled) {
        console.error("Stop is for sandboxed workspaces. For bare-metal, use Ctrl+C or systemctl stop nest.");
        process.exit(1);
    }

    const containerName = `nest-${config.instance?.name ?? "default"}`;
    console.log(`Stopping container "${containerName}"...`);

    const result = spawnSync("docker", ["stop", containerName], { stdio: "inherit" });
    if (result.status === 0) {
        spawnSync("docker", ["rm", containerName], { stdio: "inherit" });
        console.log("Stopped.");
    } else {
        console.error(`Container "${containerName}" not found or already stopped.`);
        process.exit(1);
    }
}

async function cmdBuild(args: ParsedArgs): Promise<void> {
    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found");
        process.exit(1);
    }

    const { loadConfig } = await import("./config.js");
    const configPath = join(ws.path, "config.yaml");
    const config = loadConfig(configPath);

    if (!config.instance?.sandbox?.enabled) {
        console.error("Build is for sandboxed workspaces.");
        process.exit(1);
    }

    const image = config.instance.sandbox.image ?? "nest:latest";

    // Look for Dockerfile in workspace first, fall back to nest's own
    const dockerfilePaths = [
        join(ws.path, "Dockerfile"),
        join(new URL(".", import.meta.url).pathname, "..", "Dockerfile"),
    ];
    const dockerfile = dockerfilePaths.find((p) => existsSync(p));
    if (!dockerfile) {
        console.error("Error: no Dockerfile found");
        process.exit(1);
    }

    const context = dirname(dockerfile);
    console.log(`Building image "${image}" from ${dockerfile}`);

    const result = spawnSync("docker", ["build", "-t", image, "-f", dockerfile, context], {
        stdio: "inherit",
    });

    if (result.status !== 0) {
        console.error("Build failed.");
        process.exit(1);
    }

    console.log(`\nImage "${image}" built successfully.`);
}

async function cmdRebuild(args: ParsedArgs): Promise<void> {
    // Stop (if running) → build → start
    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found");
        process.exit(1);
    }

    const { loadConfig } = await import("./config.js");
    const configPath = join(ws.path, "config.yaml");
    const config = loadConfig(configPath);
    const containerName = `nest-${config.instance?.name ?? "default"}`;

    // Stop if running
    const check = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf-8",
    });
    if (check.status === 0) {
        console.log(`Stopping "${containerName}"...`);
        spawnSync("docker", ["stop", containerName], { stdio: "inherit" });
        spawnSync("docker", ["rm", containerName], { stdio: "inherit" });
    }

    // Build
    await cmdBuild(args);

    // Start
    console.log();
    await cmdStart(args);
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

    function createBridge(opts: { cwd: string; command?: string; args?: string[] }) {
        const sessionConfig = Object.values(config.sessions).find(
            (s) => s.pi.cwd === opts.cwd,
        );
        const extensions = sessionConfig?.pi.extensions;

        const bridgeArgs = [...(opts.args ?? ["--mode", "rpc", "--continue"])];
        if (extensions) {
            for (const ext of extensions) {
                bridgeArgs.push("-e", ext);
            }
        }

        const agentDir = sessionConfig?.pi.agentDir ?? config.instance?.agentDir;
        const env: Record<string, string> = {};
        if (agentDir) {
            env.PI_CODING_AGENT_DIR = resolve(agentDir);
        }

        return new Bridge({
            cwd: opts.cwd,
            command: opts.command,
            args: bridgeArgs,
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
    const ws = resolveWorkspace(args.workspace);
    if (!ws) {
        console.error(args.workspace
            ? `Error: workspace "${args.workspace}" not found`
            : "Error: no workspace found");
        console.error('Run "nest list" to see known workspaces');
        process.exit(1);
    }

    const { loadConfig } = await import("./config.js");
    const configPath = join(ws.path, "config.yaml");
    const config = loadConfig(configPath);

    // Resolve which nest session to attach to
    const sessionNames = Object.keys(config.sessions);
    const sessionName = args.session ?? config.defaultSession ?? sessionNames[0];

    let sessionConfig = config.sessions[sessionName];

    // If the session doesn't exist, create it using the default session's config
    if (!sessionConfig) {
        const defaultName = config.defaultSession ?? sessionNames[0];
        const defaultConfig = config.sessions[defaultName];
        if (!defaultConfig) {
            console.error(`Error: no sessions configured`);
            process.exit(1);
        }

        sessionConfig = { ...defaultConfig };
        console.log(`Creating new session "${sessionName}" (based on "${defaultName}")`);
    }
    const agentDir = sessionConfig.pi.agentDir ?? config.instance?.agentDir;
    const cwd = sessionConfig.pi.cwd;

    // --continue resumes last conversation if one exists, starts fresh if none.
    // --session-dir isolates conversations per nest session.
    // Once in the TUI, use /new or /resume to manage conversations.
    const agentDirResolved = agentDir ? resolve(ws.path, agentDir) : undefined;
    const sessionDir = agentDirResolved
        ? join(agentDirResolved, "sessions", sessionName)
        : undefined;
    if (sessionDir) {
        mkdirSync(sessionDir, { recursive: true });
    }

    const piArgs = ["--continue"];
    if (sessionDir) {
        piArgs.push("--session-dir", sessionDir);
    }

    // Add extensions
    if (sessionConfig.pi.extensions) {
        for (const ext of sessionConfig.pi.extensions) {
            piArgs.push("-e", ext);
        }
    }

    // Build env
    const env: Record<string, string | undefined> = { ...process.env };
    if (agentDir) {
        env.PI_CODING_AGENT_DIR = resolve(ws.path, agentDir);
    }

    console.log(`Attaching to session "${sessionName}"`);
    console.log(`  cwd: ${cwd}`);
    if (agentDir) {
        console.log(`  agent dir: ${resolve(ws.path, agentDir)}`);
    }
    console.log(`  Use /new or /resume in the TUI to manage conversations`);
    console.log();

    // Spawn pi in interactive mode with inherited stdio (full TUI)
    const pi = spawn("pi", piArgs, {
        cwd,
        env,
        stdio: "inherit",
    });

    pi.on("exit", (code) => {
        process.exit(code ?? 0);
    });

    pi.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            console.error("Error: pi not found. Install pi: npm install -g @mariozechner/pi-coding-agent");
        } else {
            console.error(`Error spawning pi: ${err.message}`);
        }
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

    const { loadConfig } = await import("./config.js");
    const config = loadConfig(join(ws.path, "config.yaml"));

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
