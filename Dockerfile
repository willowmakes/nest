# ─── Nest: sandboxed agent gateway ───────────────────────────
# Multi-stage build: compile TypeScript, then run in a Debian
# container with nix available for the agent to install deps.

# ─── Stage 1: Build ─────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx tsc

# ─── Stage 2: Runtime ───────────────────────────────────────
FROM node:22-bookworm

# Core tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client curl wget jq \
    ripgrep fd-find fzf tree less vim-tiny \
    build-essential python3 python3-pip python3-venv \
    ca-certificates dnsutils iptables iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Install nix (single-user, no daemon)
RUN curl -L https://nixos.org/nix/install | sh -s -- --no-daemon \
    && ln -s /root/.nix-profile/bin/* /usr/local/bin/ 2>/dev/null || true

# pi coding agent
RUN npm install -g @mariozechner/pi-coding-agent@0.53.1

WORKDIR /app

# Copy built nest from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/extensions ./extensions
COPY --from=build /app/src ./src

# Entrypoint: LAN isolation + capability drop
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8484/health || exit 1

# Make nest importable by name from plugins anywhere in the container
RUN ln -s /app /usr/local/lib/node_modules/nest

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash", "-c", "cd /app && exec node --import tsx/esm dist/cli.js start --config /home/wren/config.yaml"]
