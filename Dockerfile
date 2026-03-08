# ─── Nest: sandboxed agent gateway ───────────────────────────
# Multi-stage build: build nest, then run in a nix-enabled container
#
# The workspace directory is bind-mounted at /workspace.
# Nix is available for the agent to install arbitrary dependencies.

# ─── Stage 1: Build ─────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx tsc

# ─── Stage 2: Runtime ───────────────────────────────────────
FROM nixos/nix:latest AS runtime

# Install node in the nix environment
RUN nix-channel --update && \
    nix-env -iA nixpkgs.nodejs_22 nixpkgs.git nixpkgs.openssh nixpkgs.curl

# Set up working directory
WORKDIR /app

# Copy built nest from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/plugins ./plugins

# The workspace is bind-mounted at /workspace at runtime.
# It contains: config.yaml, plugins/, cron.d/, .pi/agent/, usage.jsonl
#
# The agent's working directory (pi cwd) is also bind-mounted
# at its original path so file operations work naturally.

ENV NODE_ENV=production

# Default: start the gateway from the bind-mounted workspace config
CMD ["node", "dist/cli.js", "start", "--config", "/workspace/config.yaml"]
