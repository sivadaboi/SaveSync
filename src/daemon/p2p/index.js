import db from '../db.js';
import { DiscoveryManager } from './discovery.js';
import { WanClientManager } from './wan-client.js';
import { SyncEngine } from './sync-engine.js';
import { registerExpressRoutes } from './routes.js';
import { getFolderManifest, getManifestHash } from '../delta.js';
import { getLatestSnapshot } from '../snapshot.js';

class P2PEngine {
  constructor() {
    this.discoveredPeers = {}; // id -> { deviceName, address, port, lastSeen, isWan }
    this.pairingRequests = {}; // peerId -> { deviceName, address, port, isWan }
    this.activeSyncs = {}; // gameId -> boolean
    this.activeConflicts = {}; // gameId -> { peer, localSnap, remoteSnap }
    this.onPeerUpdate = null;

    this.peerGameStates = {}; // peerId -> { [gameId]: { latestSnapshotId, latestSnapshotTime, activeBranch, manifestHash } }
    this.pingInterval = null;

    this.discovery = new DiscoveryManager(this);
    this.wanClient = new WanClientManager(this);
    this.syncEngine = new SyncEngine(this);
  }

  init(port) {
    this.localPort = port;
    this.discovery.start(port);
    this.wanClient.connect();

    this.pingInterval = setInterval(async () => {
      await this.pingPairedPeers();
      if (typeof this.onPeerUpdate === 'function') {
        this.onPeerUpdate();
      }
    }, 10000);
  }

  getLocalGamesState() {
    const games = db.getGames();
    const state = {};
    for (const gameId in games) {
      const game = games[gameId];
      let manifestHash = '';
      try {
        const manifest = getFolderManifest(game.savePath);
        manifestHash = getManifestHash(manifest);
      } catch (e) {
        // Ignore
      }
      const latestSnap = getLatestSnapshot(gameId);
      state[gameId] = {
        latestSnapshotId: latestSnap ? latestSnap.id : null,
        latestSnapshotTime: latestSnap ? new Date(latestSnap.timestamp).getTime() : 0,
        activeBranch: game.activeBranch,
        manifestHash: manifestHash
      };
    }
    return state;
  }

  getGameSyncStatus(gameId) {
    const peers = db.getPeers();
    const onlinePeers = Object.values(peers).filter(p => p.status === 'online');

    if (onlinePeers.length === 0) {
      return 'local-only';
    }

    const game = db.getGame(gameId);
    if (!game) return 'local-only';

    let localManifestHash = '';
    try {
      const localManifest = getFolderManifest(game.savePath);
      localManifestHash = getManifestHash(localManifest);
    } catch (e) {
      // Ignore
    }

    let allSynced = true;
    let peerHasGame = false;

    for (const peer of onlinePeers) {
      const peerState = this.peerGameStates[peer.id];
      if (peerState && peerState[gameId]) {
        peerHasGame = true;
        const peerHash = peerState[gameId].manifestHash;
        if (peerHash !== localManifestHash) {
          allSynced = false;
          break;
        }
      } else {
        // Peer doesn't have it tracked yet
        allSynced = false;
      }
    }

    if (!peerHasGame) {
      return 'local-only';
    }

    return allSynced ? 'synced' : 'out-of-sync';
  }

  connectToRelay() {
    this.wanClient.connect();
  }

  getLocalPeerId() {
    const settings = db.getSettings();
    if (settings.nodeId) return settings.nodeId;
    return `${settings.deviceName.toLowerCase().replace(/[^a-z0-9]/g, '')}_node`;
  }

  getWanRoomStatus() {
    return this.wanClient.getWanRoomStatus();
  }

  sendRelayMessage(msg) {
    this.wanClient.sendRelayMessage(msg);
  }

  sendWanRequest(peerId, route, method = 'GET', body = null) {
    return this.wanClient.sendWanRequest(peerId, route, method, body);
  }

  async p2pRequest(peer, route, method = 'GET', body = null) {
    if (peer.address === 'relay' || peer.isWan) {
      return this.sendWanRequest(peer.id, route, method, body);
    } else {
      const url = `http://${peer.address}:${peer.port}/api/p2p${route}`;
      const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000)
      };
      if (body) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      return response.json();
    }
  }

  getDiscoveredPeers() {
    return Object.values(this.discoveredPeers);
  }

  getPairingRequests() {
    return Object.values(this.pairingRequests);
  }

  registerRoutes(app) {
    registerExpressRoutes(app, this);
  }

  async pingPairedPeers() {
    const peers = db.getPeers();

    for (const peerId in peers) {
      const peer = peers[peerId];
      if (peer.address === 'relay' || peer.isWan) {
        const disc = this.discoveredPeers[peerId];
        if (disc && Date.now() - disc.lastSeen < 20000) {
          db.updatePeer(peerId, { status: 'online', lastSeen: Date.now() });
        } else {
          db.updatePeer(peerId, { status: 'offline' });
        }
      } else {
        try {
          const response = await fetch(`http://${peer.address}:${peer.port}/api/p2p/ping`, {
            signal: AbortSignal.timeout(2000)
          });
          if (response.ok) {
            db.updatePeer(peerId, { status: 'online', lastSeen: Date.now() });
            const data = await response.json();
            if (data.games) {
              this.peerGameStates[peerId] = data.games;
            }
          } else {
            db.updatePeer(peerId, { status: 'offline' });
          }
        } catch (err) {
          db.updatePeer(peerId, { status: 'offline' });
        }
      }
    }
  }

  async pairWithPeer(peerIp, peerPort, isWan = false, targetPeerId = null) {
    const settings = db.getSettings();
    const localPeerId = this.getLocalPeerId();

    if (isWan || peerIp === 'relay') {
      this.wanClient.sendRelayMessage({
        type: 'request',
        to: targetPeerId || undefined,
        from: localPeerId,
        route: '/handshake',
        method: 'POST',
        body: {
          peerId: localPeerId,
          deviceName: settings.deviceName,
          deviceType: settings.deviceType || 'desktop',
          port: this.localPort
        }
      });
      return { status: 'pending', message: targetPeerId ? 'Pairing request sent to WAN peer.' : 'Pairing request broadcasted in WAN group.' };
    } else {
      try {
        const response = await fetch(`http://${peerIp}:${peerPort}/api/p2p/handshake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            peerId: localPeerId,
            deviceName: settings.deviceName,
            deviceType: settings.deviceType || 'desktop',
            port: this.localPort
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || `Peer returned HTTP ${response.status}`);
        }
        return data;
      } catch (err) {
        throw new Error(`Failed to handshake with peer: ${err.message}`);
      }
    }
  }

  approvePairing(peerId) {
    const request = this.pairingRequests[peerId];
    if (!request) throw new Error('Pairing request not found.');

    db.addPeer(peerId, request.deviceName, request.address, request.port, request.deviceType || 'desktop');
    db.updatePeer(peerId, { status: 'online', lastSeen: Date.now() });

    const settings = db.getSettings();
    const localPeerId = this.getLocalPeerId();

    if (request.address === 'relay' || request.isWan) {
      this.wanClient.sendRelayMessage({
        type: 'request',
        to: peerId,
        from: localPeerId,
        route: '/approve-confirm',
        method: 'POST',
        body: {
          peerId: localPeerId,
          deviceName: settings.deviceName,
          deviceType: settings.deviceType || 'desktop',
          port: this.localPort
        }
      });
    } else {
      fetch(`http://${request.address}:${request.port}/api/p2p/approve-confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          peerId: localPeerId,
          deviceName: settings.deviceName,
          deviceType: settings.deviceType || 'desktop',
          port: this.localPort
        })
      }).catch(() => {});
    }

    delete this.pairingRequests[peerId];
    console.log(`[P2P] Approved pairing with device: ${request.deviceName}`);
    if (typeof this.onPeerUpdate === 'function') {
      this.onPeerUpdate();
    }
    return request;
  }

  rejectPairing(peerId) {
    delete this.pairingRequests[peerId];
    if (typeof this.onPeerUpdate === 'function') {
      this.onPeerUpdate();
    }
  }

  async unpairPeer(peerId) {
    const peers = db.getPeers();
    const peer = peers[peerId];
    if (!peer) return;

    // Remove locally first so the UI updates instantly
    db.removePeer(peerId);
    if (typeof this.onPeerUpdate === 'function') {
      this.onPeerUpdate();
    }

    // Inform the remote peer of the unpairing
    try {
      const localPeerId = this.getLocalPeerId();
      await this.p2pRequest(peer, '/unpair', 'POST', { peerId: localPeerId });
    } catch (err) {
      console.warn(`[P2P] Could not notify peer ${peerId} of unpairing:`, err.message);
    }
  }

  async syncGame(gameId) {
    return this.syncEngine.syncGame(gameId);
  }

  async resolveConflict(gameId, peerId, resolution) {
    return this.syncEngine.resolveConflict(gameId, peerId, resolution);
  }

  stopDiscovery() {
    this.discovery.stop();
    this.wanClient.stop();
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

const p2pEngine = new P2PEngine();
export default p2pEngine;
