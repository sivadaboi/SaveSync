import { WebSocketServer } from 'ws';
import http from 'http';
import os from 'os';

const MAX_PER_ROOM = 20;
const HEARTBEAT_MS = 30000;

class RelayManager {
  constructor() {
    this.server       = null;
    this.wss          = null;
    this.rooms        = new Map();
    this.isHosting    = false;
    this.currentPort  = 8386;
    this._heartbeat   = null;
    this._totalMsgs   = 0;
    this._totalConns  = 0;
    this._startedAt   = null;
  }

  start(port = 8386) {
    if (this.isHosting) {
      if (this.currentPort === port) return;
      this.stop();
    }

    try {
      this.currentPort = port;
      this._startedAt  = new Date().toISOString();
      this._totalMsgs  = 0;
      this._totalConns = 0;

      // ── HTTP server with /health endpoint ─────────────────────────────
      this.server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
          const roomCount   = this.rooms.size;
          const clientCount = [...this.rooms.values()].reduce((s, r) => s + r.size, 0);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({
            status:           'ok',
            version:          '1.1.0',
            uptime:           process.uptime(),
            startedAt:        this._startedAt,
            rooms:            roomCount,
            clients:          clientCount,
            totalConnections: this._totalConns,
            totalMessages:    this._totalMsgs
          }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found\n');
      });

      this.wss   = new WebSocketServer({ server: this.server });
      this.rooms = new Map();

      this.wss.on('connection', (ws, req) => {
        this._totalConns++;
        const url        = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const roomCode   = url.searchParams.get('room');
        const deviceName = url.searchParams.get('device') || 'Unknown Device';

        if (!roomCode) {
          ws.close(4001, "Missing 'room' parameter");
          return;
        }

        if (!this.rooms.has(roomCode)) this.rooms.set(roomCode, new Set());
        const clientSet = this.rooms.get(roomCode);

        if (clientSet.size >= MAX_PER_ROOM) {
          ws.close(4002, 'Room is full');
          return;
        }

        clientSet.add(ws);
        ws.roomCode   = roomCode;
        ws.deviceName = deviceName;
        ws.isAlive    = true;

        ws.on('message', (message) => {
          this._totalMsgs++;
          const targetRoom = this.rooms.get(ws.roomCode);
          if (!targetRoom) return;
          for (const client of targetRoom) {
            if (client !== ws && client.readyState === 1) {
              client.send(message);
            }
          }
        });

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('close', () => {
          const targetRoom = this.rooms.get(ws.roomCode);
          if (targetRoom) {
            targetRoom.delete(ws);
            if (targetRoom.size === 0) {
              this.rooms.delete(ws.roomCode);
            }
          }
        });

        ws.on('error', () => {});
      });

      // ── Heartbeat to drop zombie connections ──────────────────────────
      this._heartbeat = setInterval(() => {
        if (!this.wss) return;
        for (const client of this.wss.clients) {
          if (!client.isAlive) { client.terminate(); continue; }
          client.isAlive = false;
          client.ping();
        }
      }, HEARTBEAT_MS);

      this.server.listen(port, '0.0.0.0', () => {
        console.log(`[Relay Manager] Local WAN relay started on port ${port}`);
      });

      this.isHosting = true;
    } catch (err) {
      console.error('[Relay Manager] Failed to start local relay:', err.message);
      this.stop();
    }
  }

  stop() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    if (this.wss) {
      try { this.wss.close(); } catch (e) {}
      this.wss = null;
    }
    if (this.server) {
      try { this.server.close(); } catch (e) {}
      this.server = null;
    }
    this.rooms = new Map();
    this.isHosting = false;
    console.log('[Relay Manager] Local WAN relay server stopped.');
  }

  // Get all IPv4 local addresses
  getLocalIps() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const name in interfaces) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          addresses.push(iface.address);
        }
      }
    }
    return addresses;
  }

  // Query public IP address from external API
  async getPublicIp() {
    try {
      const response = await fetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        const data = await response.json();
        return data.ip;
      }
    } catch (e) {
      // Ignore query errors
    }
    return 'Could not retrieve (offline)';
  }
}

const relayManager = new RelayManager();
export default relayManager;
