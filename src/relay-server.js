/**
 * SaveSync WAN Relay Server
 * ─────────────────────────────────────────────────────────────
 * Lightweight WebSocket message broker.  Every client that
 * connects with the same ?room= code is placed in a room and
 * messages are relayed to all other members.
 *
 * Deploy for free:
 *   Render  : render.yaml in project root
 *   Railway : `railway up`  (auto-detects node)
 *   Fly.io  : `fly launch` (auto-detects Dockerfile)
 *
 * Environment variables:
 *   PORT          — TCP port to listen on   (default 8386)
 *   MAX_PER_ROOM  — max WS clients per room (default 20)
 *   HEARTBEAT_MS  — ping interval ms        (default 30000)
 */

import { WebSocketServer } from 'ws';
import http from 'http';

const PORT          = parseInt(process.env.PORT          || '8386',  10);
const MAX_PER_ROOM  = parseInt(process.env.MAX_PER_ROOM  || '20',    10);
const HEARTBEAT_MS  = parseInt(process.env.HEARTBEAT_MS  || '30000', 10);

// ── Stats ──────────────────────────────────────────────────────────────────
let totalConnections  = 0;
let totalMessages     = 0;
const serverStartedAt = new Date().toISOString();

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Health-check endpoint used by cloud platforms and the SaveSync UI
  if (req.url === '/health' || req.url === '/') {
    const roomCount   = rooms.size;
    const clientCount = [...rooms.values()].reduce((s, r) => s + r.size, 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      status:           'ok',
      version:          '1.1.0',
      uptime:           process.uptime(),
      startedAt:        serverStartedAt,
      rooms:            roomCount,
      clients:          clientCount,
      totalConnections,
      totalMessages
    }));
    return;
  }

  // Catch-all
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found\n');
});

// ── WebSocket Server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

/** @type {Map<string, Set<WebSocket>>} */
const rooms = new Map();

wss.on('connection', (ws, req) => {
  totalConnections++;

  // Parse query params
  const url        = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const roomCode   = url.searchParams.get('room');
  const deviceName = url.searchParams.get('device') || 'Unknown Device';

  if (!roomCode) {
    ws.close(4001, "Missing 'room' parameter");
    return;
  }

  // Room limit guard
  if (!rooms.has(roomCode)) rooms.set(roomCode, new Set());
  const clientSet = rooms.get(roomCode);

  if (clientSet.size >= MAX_PER_ROOM) {
    ws.close(4002, 'Room is full');
    console.warn(`[Relay] Room "${roomCode}" is full (${MAX_PER_ROOM} max). Rejected "${deviceName}".`);
    return;
  }

  clientSet.add(ws);
  ws.roomCode   = roomCode;
  ws.deviceName = deviceName;
  ws.isAlive    = true;

  console.log(`[Relay] "${deviceName}" joined room "${roomCode}" (${clientSet.size}/${MAX_PER_ROOM})`);

  // ── Relay messages ───────────────────────────────────────────────────────
  ws.on('message', (message) => {
    totalMessages++;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    for (const client of room) {
      if (client !== ws && client.readyState === 1 /* OPEN */) {
        client.send(message);
      }
    }
  });

  // ── Heartbeat pong ───────────────────────────────────────────────────────
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Clean up on disconnect ───────────────────────────────────────────────
  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (room) {
      room.delete(ws);
      if (room.size === 0) rooms.delete(ws.roomCode);
    }
    console.log(`[Relay] "${ws.deviceName}" left room "${ws.roomCode}"`);
  });

  ws.on('error', (err) => {
    console.error(`[Relay] Client error for "${ws.deviceName}":`, err.message);
  });
});

// ── Heartbeat timer — drop zombie connections ──────────────────────────────
const heartbeatTimer = setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeatTimer));

// ── Graceful shutdown ──────────────────────────────────────────────────────
function shutdown() {
  console.log('\n[Relay] Shutting down gracefully...');
  clearInterval(heartbeatTimer);
  wss.close(() => server.close(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ── Start listening ────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('════════════════════════════════════════════════════');
  console.log(`  SaveSync WAN Relay Server v1.1.0`);
  console.log(`  Listening on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  Max per room: ${MAX_PER_ROOM}  |  Heartbeat: ${HEARTBEAT_MS}ms`);
  console.log('════════════════════════════════════════════════════');
});

export default server;
