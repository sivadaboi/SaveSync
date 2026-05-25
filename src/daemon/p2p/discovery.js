import dgram from 'dgram';
import os from 'os';
import db from '../db.js';
import { log } from '../logger.js';

export function getActiveIPv4Interfaces() {
  const interfaces = os.networkInterfaces();
  const active = [];
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name]) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) {
        let broadcast = '255.255.255.255';
        try {
          const ipParts = info.address.split('.').map(Number);
          const maskParts = info.netmask.split('.').map(Number);
          const broadcastParts = [];
          for (let i = 0; i < 4; i++) {
            broadcastParts.push(ipParts[i] | (~maskParts[i] & 255));
          }
          broadcast = broadcastParts.join('.');
        } catch (e) {}
        active.push({
          address: info.address,
          broadcast: broadcast
        });
      }
    }
  }
  return active;
}

export class DiscoveryManager {
  constructor(p2pEngine) {
    this.p2pEngine = p2pEngine;
    this.udpSocket = null;
    this.discoveredPeers = {}; // key (address:port) -> peer object
    
    this.discoveryInterval = null;
    this.cleanPeersInterval = null;
    
    this.broadcastPort = 8385;
    this.multicastAddress = '224.0.0.1';
  }

  start(localPort) {
    this.localPort = localPort;
    try {
      this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.udpSocket.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString());

          // Filter: only process savesync-pings
          if (data.type !== 'savesync-ping') return;

          // Filter: ignore messages from our own nodeId or our own IP addresses
          const settings = db.getSettings();
          const localNodeId = settings.nodeId;
          if (data.nodeId === localNodeId) return;

          const localIps = getActiveIPv4Interfaces().map(i => i.address);
          if (localIps.includes(rinfo.address)) return;

          const peerId = data.nodeId ||
            `${data.deviceName.toLowerCase().replace(/[^a-z0-9]/g, '')}_${rinfo.address}`;
          const key = `${rinfo.address}:${data.port}`;

          const isNew = !this.discoveredPeers[key];

          this.discoveredPeers[key] = {
            id: peerId,
            deviceName: data.deviceName,
            deviceType: data.deviceType || 'desktop',
            address: rinfo.address,
            port: data.port,
            isWan: false,
            lastSeen: Date.now()
          };

          let pairedChanged = false;
          const pairedPeers = db.getPeers();
          if (pairedPeers[peerId]) {
            const wasOffline = pairedPeers[peerId].status !== 'online';
            db.updatePeer(peerId, {
              address: rinfo.address,
              port: data.port,
              deviceType: data.deviceType || 'desktop',
              status: 'online',
              lastSeen: Date.now()
            });
            if (wasOffline) pairedChanged = true;
          }

          if ((isNew || pairedChanged) && typeof this.p2pEngine.onPeerUpdate === 'function') {
            this.p2pEngine.onPeerUpdate();
          }
        } catch (e) {}
      });

      this.udpSocket.on('error', (err) => {
        console.error('[P2P Discovery] UDP Socket error:', err.message);
        this.stop();
      });

      // Bind to all interfaces explicitly
      this.udpSocket.bind({ port: this.broadcastPort, address: '0.0.0.0' }, () => {
        try {
          this.udpSocket.setBroadcast(true);
        } catch (e) {
          console.error('[P2P Discovery] Failed to set UDP broadcast:', e.message);
        }

        // Join multicast group on all active local interfaces
        const activeInterfaces = getActiveIPv4Interfaces();
        console.log(`[P2P Discovery] Active network interfaces:`, activeInterfaces.map(i => `${i.address} (bcast: ${i.broadcast})`));

        let joinedCount = 0;
        for (const iface of activeInterfaces) {
          try {
            this.udpSocket.addMembership(this.multicastAddress, iface.address);
            console.log(`[P2P Discovery] Joined multicast ${this.multicastAddress} on ${iface.address}`);
            joinedCount++;
          } catch (err) {
            console.error(`[P2P Discovery] Failed to join multicast on ${iface.address}:`, err.message);
          }
        }

        // Fallback
        if (joinedCount === 0) {
          try {
            this.udpSocket.addMembership(this.multicastAddress);
            console.log(`[P2P Discovery] Joined multicast on default interface`);
          } catch (err) {
            console.error('[P2P Discovery] Failed to join multicast on default interface:', err.message);
          }
        }

        console.log(`[P2P Discovery] UDP Discovery listening on port ${this.broadcastPort}`);
        // Broadcast immediately on startup
        this.broadcastPresence();
      });

      // Broadcast every 3 seconds
      this.discoveryInterval = setInterval(() => {
        this.broadcastPresence();
      }, 3000);

      // Peer cleanup every 5 seconds
      this.cleanPeersInterval = setInterval(() => {
        const now = Date.now();
        let changed = false;

        for (const key in this.discoveredPeers) {
          if (now - this.discoveredPeers[key].lastSeen > 20000) {
            delete this.discoveredPeers[key];
            changed = true;
          }
        }

        const pairedPeers = db.getPeers();
        for (const peerId in pairedPeers) {
          const peer = pairedPeers[peerId];
          // Only mark offline if they are a LAN peer (isWan is falsy)
          const isWanPeer = peer.address === 'relay' || peer.isWan;
          if (!isWanPeer && peer.lastSeen && now - peer.lastSeen > 20000 && peer.status === 'online') {
            db.updatePeer(peerId, { status: 'offline' });
            changed = true;
          }
        }

        if (changed && typeof this.p2pEngine.onPeerUpdate === 'function') {
          this.p2pEngine.onPeerUpdate();
        }
      }, 5000);

    } catch (err) {
      console.error('[P2P Discovery] UDP Discovery failed to start:', err.message);
    }
  }

  broadcastPresence() {
    if (!this.udpSocket) return;

    try {
      const settings = db.getSettings();
      const message = Buffer.from(
        JSON.stringify({
          type: 'savesync-ping',
          nodeId: settings.nodeId,
          deviceName: settings.deviceName,
          deviceType: settings.deviceType || 'desktop',
          port: this.localPort
        })
      );

      const activeInterfaces = getActiveIPv4Interfaces();

      // Send on each active interface
      for (const iface of activeInterfaces) {
        // Subnet broadcast (most reliable on Windows)
        try {
          this.udpSocket.send(message, 0, message.length, this.broadcastPort, iface.broadcast);
        } catch (e) {}

        // Multicast on this interface
        try {
          this.udpSocket.setMulticastInterface(iface.address);
          this.udpSocket.send(message, 0, message.length, this.broadcastPort, this.multicastAddress);
        } catch (e) {}
      }

      // Also send global broadcast as fallback
      try {
        this.udpSocket.send(message, 0, message.length, this.broadcastPort, '255.255.255.255');
      } catch (e) {}

    } catch (err) {
      console.error('[P2P Discovery] UDP broadcastPresence error:', err.message);
    }
  }

  stop() {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
    if (this.cleanPeersInterval) {
      clearInterval(this.cleanPeersInterval);
      this.cleanPeersInterval = null;
    }
    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch (e) {}
      this.udpSocket = null;
    }
    console.log('[P2P Discovery] UDP Discovery stopped.');
  }

  getDiscoveredPeers() {
    return Object.values(this.discoveredPeers);
  }
}
