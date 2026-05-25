import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { log } from '../logger.js';
import { getFolderManifest, readBlocks } from '../delta.js';
import { getLatestSnapshot } from '../snapshot.js';

export class WanClientManager {
  constructor(p2pEngine) {
    this.p2pEngine = p2pEngine;
    this.relaySocket = null;
    this.pendingWanRequests = new Map(); // msgId -> { resolve, reject, timeout }
    this.relayReconnectTimeout = null;
    this.relayState = 'disconnected';
    this.relayLastError = null;
    this.pingInterval = null;
  }

  connect() {
    if (this.relayReconnectTimeout) {
      clearTimeout(this.relayReconnectTimeout);
      this.relayReconnectTimeout = null;
    }

    const settings = db.getSettings();
    const relayUrl = settings.relayUrl;
    const syncCode = settings.syncCode;

    // If no sync code is active, disconnect and exit
    if (!syncCode) {
      this.relayState = 'disconnected';
      this.relayLastError = null;
      this.stop();
      return;
    }

    const localPeerId = this.p2pEngine.getLocalPeerId();
    const wsUrl = `${relayUrl}/?room=${syncCode}&device=${encodeURIComponent(settings.deviceName)}`;

    log('info', 'Connecting to WAN Relay', `${relayUrl} (Room: ${syncCode})`);
    this.relayState = 'connecting';
    this.relayLastError = null;

    if (this.relaySocket) {
      try { this.relaySocket.close(); } catch (e) {}
    }

    try {
      this.relaySocket = new WebSocket(wsUrl);
      const socket = this.relaySocket;

      socket.on('open', () => {
        this.relayState = 'connected';
        this.relayLastError = null;
        log('success', 'Connected to WAN Relay successfully.');

        // Broadcast presence in the WebSocket room
        this.sendRelayMessage({
          type: 'hello',
          from: localPeerId,
          deviceName: settings.deviceName,
          deviceType: settings.deviceType || 'desktop',
          port: this.p2pEngine.localPort
        });

        // Start ping interval (every 3 seconds) to keep connection alive and update presence
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          this.sendHeartbeat();
        }, 3000);

        if (typeof this.p2pEngine.onPeerUpdate === 'function') {
          this.p2pEngine.onPeerUpdate();
        }
      });

      socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleRelayMessage(message);
        } catch (e) {
          log('error', 'Failed to parse relay message', e.message);
        }
      });

      socket.on('close', () => {
        if (this.relaySocket !== socket) return;
        this.relayState = 'disconnected';
        log('info', 'WAN Relay connection closed', 'Reconnecting in 5 seconds...');
        this.stop();
        if (typeof this.p2pEngine.onPeerUpdate === 'function') {
          this.p2pEngine.onPeerUpdate();
        }
        this.relayReconnectTimeout = setTimeout(() => this.connect(), 5000);
      });

      socket.on('error', (err) => {
        if (this.relaySocket !== socket) return;
        this.relayState = 'error';
        this.relayLastError = err.message;
        log('error', 'WAN Relay error', err.message);
        if (typeof this.p2pEngine.onPeerUpdate === 'function') {
          this.p2pEngine.onPeerUpdate();
        }
        this.stop();
        this.relayReconnectTimeout = setTimeout(() => this.connect(), 5000);
      });

    } catch (err) {
      this.relayState = 'error';
      this.relayLastError = err.message;
      log('error', 'Failed to initiate WAN Relay connection', err.message);
      this.relayReconnectTimeout = setTimeout(() => this.connect(), 5000);
    }
  }

  sendHeartbeat() {
    if (this.relaySocket && this.relaySocket.readyState === WebSocket.OPEN) {
      try {
        this.sendRelayMessage({
          type: 'ping',
          from: this.p2pEngine.getLocalPeerId(),
          deviceName: db.getSettings().deviceName,
          deviceType: db.getSettings().deviceType || 'desktop',
          port: this.p2pEngine.localPort
        });
      } catch (err) {}
    }
  }

  sendRelayMessage(msg) {
    if (this.relaySocket && this.relaySocket.readyState === WebSocket.OPEN) {
      this.relaySocket.send(JSON.stringify(msg));
    }
  }

  stop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.relaySocket) {
      try { this.relaySocket.close(); } catch (e) {}
      this.relaySocket = null;
    }
  }

  getWanRoomStatus() {
    const settings = db.getSettings();
    const peers = Object.values(this.p2pEngine.discoveredPeers)
      .filter(peer => peer.isWan || peer.address === 'relay')
      .map(peer => ({
        ...peer,
        paired: !!db.getPeers()[peer.id],
        online: Date.now() - peer.lastSeen < 20000
      }))
      .sort((a, b) => a.deviceName.localeCompare(b.deviceName));

    return {
      enabled: !!settings.syncCode,
      connected: this.relaySocket?.readyState === WebSocket.OPEN,
      state: this.relayState,
      error: this.relayLastError,
      relayUrl: settings.relayUrl,
      roomCode: settings.syncCode,
      localPeerId: this.p2pEngine.getLocalPeerId(),
      peers
    };
  }

  // Handle incoming message from WebSocket WAN Relay
  async handleRelayMessage(msg) {
    const localPeerId = this.p2pEngine.getLocalPeerId();
    
    // Ignore messages not sent to us (unless it is a multicast broadcast like 'hello' or 'ping')
    if (msg.to && msg.to !== localPeerId) return;

    // Track peer active presence/heartbeat
    if (msg.from && msg.from !== localPeerId) {
      const pairedPeers = db.getPeers();
      let changed = false;
      if (pairedPeers[msg.from]) {
        const wasOffline = pairedPeers[msg.from].status !== 'online';
        db.updatePeer(msg.from, {
          status: 'online',
          lastSeen: Date.now()
        });
        if (wasOffline) changed = true;
      }
      if (this.p2pEngine.discoveredPeers[msg.from]) {
        this.p2pEngine.discoveredPeers[msg.from].lastSeen = Date.now();
      }
      if (changed && typeof this.p2pEngine.onPeerUpdate === 'function') {
        this.p2pEngine.onPeerUpdate();
      }
    }

    switch (msg.type) {
      case 'ping':
        if (msg.from !== localPeerId && msg.deviceName) {
          const isNew = !this.p2pEngine.discoveredPeers[msg.from];
          this.p2pEngine.discoveredPeers[msg.from] = {
            id: msg.from,
            deviceName: msg.deviceName,
            deviceType: msg.deviceType || 'desktop',
            address: 'relay',
            port: msg.port,
            isWan: true,
            lastSeen: Date.now()
          };
          if (isNew && typeof this.p2pEngine.onPeerUpdate === 'function') {
            this.p2pEngine.onPeerUpdate();
          }
        }
        break;
      case 'hello':
        // A peer joined our room. Add them to discovered list.
        if (msg.from !== localPeerId) {
          const key = msg.from;
          const isNew = !this.p2pEngine.discoveredPeers[key];
          this.p2pEngine.discoveredPeers[key] = {
            id: msg.from,
            deviceName: msg.deviceName,
            deviceType: msg.deviceType || 'desktop',
            address: 'relay',
            port: msg.port,
            isWan: true,
            lastSeen: Date.now()
          };

          // Update paired list if they are paired
          let pairedChanged = false;
          const pairedPeers = db.getPeers();
          if (pairedPeers[msg.from]) {
            const wasOffline = pairedPeers[msg.from].status !== 'online';
            db.updatePeer(msg.from, {
              status: 'online',
              address: 'relay',
              port: msg.port,
              lastSeen: Date.now()
            });
            if (wasOffline) pairedChanged = true;
          }

          if ((isNew || pairedChanged) && typeof this.p2pEngine.onPeerUpdate === 'function') {
            this.p2pEngine.onPeerUpdate();
          }

          // Reply with our presence so they discover us immediately
          this.sendRelayMessage({
            type: 'hello-reply',
            to: msg.from,
            from: localPeerId,
            deviceName: db.getSettings().deviceName,
            deviceType: db.getSettings().deviceType || 'desktop',
            port: this.p2pEngine.localPort
          });
        }
        break;

      case 'hello-reply':
        if (msg.from !== localPeerId) {
          const key = msg.from;
          const isNew = !this.p2pEngine.discoveredPeers[key];
          this.p2pEngine.discoveredPeers[key] = {
            id: msg.from,
            deviceName: msg.deviceName,
            deviceType: msg.deviceType || 'desktop',
            address: 'relay',
            port: msg.port,
            isWan: true,
            lastSeen: Date.now()
          };

          let pairedChanged = false;
          const pairedPeers = db.getPeers();
          if (pairedPeers[msg.from]) {
            const wasOffline = pairedPeers[msg.from].status !== 'online';
            db.updatePeer(msg.from, {
              status: 'online',
              address: 'relay',
              port: msg.port,
              lastSeen: Date.now()
            });
            if (wasOffline) pairedChanged = true;
          }

          if ((isNew || pairedChanged) && typeof this.p2pEngine.onPeerUpdate === 'function') {
            this.p2pEngine.onPeerUpdate();
          }
        }
        break;

      case 'request':
        // Process remote request and send a response back through relay
        await this.handleRelayRequest(msg);
        break;

      case 'response':
        // Match response to pending resolve callbacks
        const pending = this.pendingWanRequests.get(msg.msgId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingWanRequests.delete(msg.msgId);
          if (msg.status >= 200 && msg.status < 300) {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(msg.data?.error || `WAN request returned status ${msg.status}`));
          }
        }
        break;
    }
  }

  // Handle incoming HTTP-like API request mapped over WS Relay
  async handleRelayRequest(msg) {
    const localPeerId = this.p2pEngine.getLocalPeerId();
    const { msgId, from, route, method, body } = msg;

    console.log(`[WAN Client] Received WAN API Request: ${method} ${route} from ${from}`);

    let status = 200;
    let data = {};

    try {
      if (route.startsWith('/manifest/')) {
        const gameId = route.split('/').pop();
        const game = db.getGame(gameId);
        if (!game) {
          status = 404;
          data = { error: 'Game not found.' };
        } else {
          const activeBranchObj = game.branches[game.activeBranch];
          data = {
            gameId,
            activeBranch: game.activeBranch,
            latestSnapshot: getLatestSnapshot(gameId),
            manifest: getFolderManifest(game.savePath),
            history: activeBranchObj ? activeBranchObj.snapshots.map(s => s.id) : []
          };
        }
      } else if (route.startsWith('/blocks/')) {
        const gameId = route.split('/').pop();
        const { relPath, blockIndices } = body;
        const game = db.getGame(gameId);
        if (!game) {
          status = 404;
          data = { error: 'Game not found.' };
        } else {
          const fullPath = path.join(game.savePath, relPath);
          data = {
            relPath,
            blocks: readBlocks(fullPath, blockIndices)
          };
        }
      } else if (route.startsWith('/snapshot/')) {
        // Retrieve snapshot file bytes and encode to base64
        const parts = route.split('/');
        const snapshotId = parts.pop();
        const gameId = parts.pop();
        const game = db.getGame(gameId);

        let snapshot = null;
        for (const b in game?.branches) {
          const snap = game.branches[b].snapshots.find(s => s.id === snapshotId);
          if (snap) {
            snapshot = snap;
            break;
          }
        }

        if (!snapshot || !fs.existsSync(snapshot.zipPath)) {
          status = 404;
          data = { error: 'Snapshot ZIP file not found.' };
        } else {
          const buffer = fs.readFileSync(snapshot.zipPath);
          data = {
            snapshotId,
            base64Data: buffer.toString('base64'),
            fileName: `${snapshotId}.zip`
          };
        }
      } else if (route.startsWith('/sync/trigger/')) {
        const gameId = route.split('/').pop();
        console.log(`[WAN Client] WAN Sync trigger received for game "${gameId}"`);
        this.p2pEngine.syncGame(gameId).catch(err => {
          console.error('[WAN Client] WAN Triggered sync failed:', err.message);
        });
        data = { success: true, message: 'Sync triggered.' };
      } else if (route === '/handshake') {
        const { peerId, deviceName, deviceType, port } = body;
        
        this.p2pEngine.pairingRequests[peerId] = {
          peerId,
          deviceName,
          deviceType: deviceType || 'desktop',
          address: 'relay',
          port,
          isWan: true
        };

        if (typeof this.p2pEngine.onPeerUpdate === 'function') {
          this.p2pEngine.onPeerUpdate();
        }

        data = { status: 'pending', message: 'Pairing request received via WAN. Waiting for approval.' };
      } else if (route === '/approve-confirm') {
        const { peerId, deviceName, deviceType, port } = body;
        
        db.addPeer(peerId, deviceName, 'relay', port, deviceType || 'desktop');
        db.updatePeer(peerId, { status: 'online', lastSeen: Date.now() });

        if (typeof this.p2pEngine.onPeerUpdate === 'function') {
          this.p2pEngine.onPeerUpdate();
        }

        data = { success: true, message: 'Pairing confirmed.' };
      } else if (route === '/ping') {
        data = { status: 'ok', deviceName: db.getSettings().deviceName, deviceType: db.getSettings().deviceType };
      } else {
        status = 404;
        data = { error: 'Endpoint not supported over WAN.' };
      }
    } catch (err) {
      status = 500;
      data = { error: err.message };
    }

    // Send response packet back to sender
    this.sendRelayMessage({
      type: 'response',
      to: from,
      from: localPeerId,
      msgId,
      status,
      data
    });
  }

  // Trigger WAN API request over WebSocket Relay
  sendWanRequest(peerId, route, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) {
        return reject(new Error('WAN Relay connection is currently offline.'));
      }

      const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const localPeerId = this.p2pEngine.getLocalPeerId();

      const timeout = setTimeout(() => {
        this.pendingWanRequests.delete(msgId);
        reject(new Error(`WAN Request timeout on route ${route}`));
      }, 30000); // 30s timeout

      this.pendingWanRequests.set(msgId, { resolve, reject, timeout });

      this.sendRelayMessage({
        type: 'request',
        to: peerId,
        from: localPeerId,
        msgId,
        route,
        method,
        body
      });
    });
  }
}
