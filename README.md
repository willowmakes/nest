# Nest

Minimal agent gateway kernel. Sessions, plugins, cron, HTTP.

Nest does five things: manages pi sessions, loads plugins, runs cron jobs, handles config, and serves HTTP. Everything else — listeners, commands, dashboards, middleware, security — is a plugin.

## Architecture

```mermaid
graph TB
    subgraph Kernel["NEST KERNEL"]
        Bridge["Bridge (pi RPC)"]
        SM["Session Manager"]
        Sched["Scheduler (cron)"]
        Config["Config (YAML)"]
        PL["Plugin Loader"]
        HTTP["HTTP Server"]
        Tracker["Usage Tracker"]
        Core["Core Commands: status, reboot, abort"]
    end

    subgraph Plugins["PLUGINS"]
        Discord["discord.ts"]
        Matrix["matrix.ts"]
        Dashboard["dashboard.ts"]
        Webhook["webhook.ts"]
        Commands["commands.ts"]
        Custom["your-plugin.ts"]
    end

    PL -- "NestAPI" --> Plugins
    Bridge <--> Pi["pi process"]

    style Kernel fill:#e8edf5,stroke:#3c5a99
    style Plugins fill:#fff5eb,stroke:#aa6633
    style Custom fill:#ffe0c0,stroke:#cc7722,stroke-dasharray: 5 5
    style Pi fill:#dcf5dc,stroke:#449944
```

## Sessions

Sessions are the central concept. Everything else attaches to them.

```mermaid
graph TB
    subgraph S1["Session: wren"]
        Pi1["pi process"]
    end
    subgraph S2["Session: background"]
        Pi2["pi process"]
    end

    D["Discord #general"] -->|attached| S1
    CLI["CLI terminal"] -->|attached| S1
    Cron1["Cron: morning"] -->|targets| S1
    Cron2["Cron: dream"] -->|targets| S2

    S1 -. "broadcasts to all attached" .-> D
    S1 -. "broadcasts to all attached" .-> CLI

    style S1 fill:#ddeeff,stroke:#3c7fbb
    style S2 fill:#ddeeff,stroke:#3c7fbb
    style D fill:#fff0e0,stroke:#aa6633
    style CLI fill:#fff0e0,stroke:#aa6633
    style Cron1 fill:#e8f5e8,stroke:#558855
    style Cron2 fill:#e8f5e8,stroke:#558855
```

- **Sessions are independent pi processes** with their own conversation history
- **Listeners attach to sessions** — Discord, CLI, webhook are all views into a session
- **Multiple listeners on one session** — CLI and Discord both see the same conversation
- **Cron jobs target sessions** — no notify channels, output goes to all attached listeners

## Message Flow

```mermaid
sequenceDiagram
    participant P as Platform
    participant L as Listener Plugin
    participant MW as Middleware
    participant K as Kernel
    participant B as Bridge
    participant Pi as pi

    P->>L: User message
    L->>MW: IncomingMessage
    MW->>K: process(msg)
    K->>B: sendMessage()
    B->>Pi: JSON-RPC
    Pi-->>B: streaming response
    B-->>K: response text
    K-->>L: broadcast to ALL attached listeners
    L-->>P: Display

    Note over MW: Can block (return null)
    Note over K,L: All listeners on the session see output
```

## Plugins

A plugin is a `.ts` file (or directory with `index.ts`) in the plugins directory. It exports a default function receiving a `NestAPI` object:

```typescript
import type { NestAPI } from "../src/types.js";

export default function(nest: NestAPI) {
    nest.registerMiddleware({
        name: "my-guard",
        async process(msg) {
            // block, transform, or pass through
            return msg;
        },
    });
}
```

### NestAPI

```typescript
interface NestAPI {
    // Register capabilities
    registerListener(listener: Listener): void;
    registerMiddleware(middleware: Middleware): void;
    registerCommand(name: string, command: Command): void;
    registerRoute(method: string, path: string, handler: RouteHandler): void;

    // Sessions (attach/detach model)
    sessions: {
        get(name): Bridge | null;
        getOrStart(name): Promise<Bridge>;
        attach(session, listener, origin): void;
        detach(session, listener): void;
        getListeners(session): Array<{ listener, origin }>;
        // ...
    };

    // Usage tracking, config, logging, instance info
    tracker: { record(), today(), week(), ... };
    config: Config;
    log: { info(), warn(), error() };
    instance: { name, dataDir };
}
```

### Shipped Plugins

| Plugin | What it does |
|--------|-------------|
| `discord.ts` | Discord listener with emoji resolution, attachments |
| `matrix.ts` | Matrix listener |
| `dashboard.ts` | API routes for status, sessions, usage, logs + static file serving |
| `webhook.ts` | POST /api/webhook → send message to session |
| `commands.ts` | Extended bot commands: model, think, compress, new, reload |

## Config

```yaml
instance:
    name: "wren"
    pluginsDir: "./plugins"

sessions:
    wren:
        pi:
            cwd: /home/wren
            extensions:
                - /app/extensions/attach.ts

defaultSession: wren

server:
    port: 8484
    token: "env:SERVER_TOKEN"

cron:
    dir: ./cron.d

# Plugin config — plugins read their own sections
discord:
    token: "env:DISCORD_TOKEN"
    channels:
        "123456": "wren"
```

## Running

```bash
npm install
npm run dev              # tsx src/main.ts
npm run dev config.yaml  # custom config path
```

## Writing Plugins

1. Create a `.ts` file in the plugins directory
2. Export a default function that takes `NestAPI`
3. Call registration methods to add capabilities
4. Restart nest to load the plugin

The agent can write plugins too — that's the point.

## File Structure

```
nest/
├── src/                    # Kernel (~2,700 lines)
│   ├── main.ts             # Entry point
│   ├── kernel.ts           # Core orchestration
│   ├── bridge.ts           # RPC pipe to pi
│   ├── session-manager.ts  # Sessions (central hub)
│   ├── scheduler.ts        # Cron
│   ├── config.ts           # YAML config
│   ├── plugin-loader.ts    # Scan, import, inject NestAPI
│   ├── server.ts           # HTTP skeleton
│   ├── types.ts            # All interfaces
│   ├── tracker.ts          # Usage tracking
│   └── ...                 # logger, chunking, image, inbox
├── plugins/                # Features (~600 lines)
│   ├── discord.ts
│   ├── matrix.ts
│   ├── dashboard.ts
│   ├── webhook.ts
│   └── commands.ts
└── config.yaml
```
