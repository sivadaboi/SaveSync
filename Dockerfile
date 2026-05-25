# ─────────────────────────────────────────────────────
# SaveSync Relay Server — Dockerfile
# Minimal Node.js 20 image for cloud deployment
# ─────────────────────────────────────────────────────

FROM node:20-alpine

WORKDIR /app

# Copy only what the relay server needs
COPY package-relay.json ./package.json
RUN npm install --omit=dev

COPY src/relay-server.js ./relay-server.js

EXPOSE 8386

ENV PORT=8386
ENV MAX_PER_ROOM=20
ENV HEARTBEAT_MS=30000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "relay-server.js"]
