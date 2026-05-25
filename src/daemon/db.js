import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const DEFAULT_PORT = 8383;
const HOME_DIR = path.join(os.homedir(), '.savesync');
const DB_FILE = path.join(HOME_DIR, 'savesync-db.json');

// Ensure home directories exist
if (!fs.existsSync(HOME_DIR)) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
}
const BACKUPS_DIR = path.join(HOME_DIR, 'backups');
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

// Public SaveSync cloud relay — deployed on Render.com free tier.
// Users who self-host can override this in Settings > Internet Sync.
const CLOUD_RELAY_URL = 'wss://savesync-relay.onrender.com';

const defaultState = {
  settings: {
    deviceName: os.hostname() || 'Unknown Device',
    nodeId: `node_${crypto.randomUUID().replace(/-/g, '')}`,
    deviceType: 'desktop',
    port: DEFAULT_PORT,
    syncInterval: 5000,
    syncOnWatch: true,
    dataDir: HOME_DIR,
    backupsDir: BACKUPS_DIR,
    relayUrl: CLOUD_RELAY_URL,
    syncCode: '',
    hostRelay: false,
    relayPort: 8386,
    startOnBoot: false,
    speedLimit: 0
  },
  games: {},
  peers: {}
};

class Database {
  constructor() {
    this.data = { ...defaultState };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const fileContent = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(fileContent);
        // Fill in missing default structures if database is older
        this.data.settings = { ...defaultState.settings, ...this.data.settings };
        if (!this.data.settings.nodeId) {
          this.data.settings.nodeId = `node_${crypto.randomUUID().replace(/-/g, '')}`;
        }
        this.data.games = this.data.games || {};
        this.data.peers = this.data.peers || {};
        this.save();
      } else {
        this.data = JSON.parse(JSON.stringify(defaultState));
        this.save();
      }
    } catch (error) {
      console.error('Error loading database, resetting to default:', error);
      this.data = JSON.parse(JSON.stringify(defaultState));
      this.save();
    }
  }

  save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      console.error('Error saving database:', error);
    }
  }

  getSettings() {
    return this.data.settings;
  }

  updateSettings(newSettings) {
    this.data.settings = { ...this.data.settings, ...newSettings };
    this.save();
    return this.data.settings;
  }

  getGames() {
    return this.data.games;
  }

  getGame(id) {
    return this.data.games[id];
  }

  addGame(name, savePath) {
    // Generate clean ID from name
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    
    if (this.data.games[id]) {
      throw new Error(`Game with name/id "${name}" already exists.`);
    }

    this.data.games[id] = {
      id,
      name,
      savePath: path.resolve(savePath),
      activeBranch: 'main',
      branches: {
        main: {
          name: 'main',
          snapshots: [] // list of snapshot metadata
        }
      },
      createdAt: new Date().toISOString()
    };
    
    this.save();
    return this.data.games[id];
  }

  removeGame(id) {
    if (!this.data.games[id]) {
      throw new Error(`Game ID "${id}" not found.`);
    }
    delete this.data.games[id];
    this.save();
  }

  updateGame(id, fields) {
    if (!this.data.games[id]) {
      throw new Error(`Game ID "${id}" not found.`);
    }
    this.data.games[id] = { ...this.data.games[id], ...fields };
    this.save();
    return this.data.games[id];
  }

  getPeers() {
    return this.data.peers;
  }

  addPeer(peerId, name, address, port, deviceType = 'desktop') {
    this.data.peers[peerId] = {
      id: peerId,
      name,
      deviceType,
      address,
      port: parseInt(port, 10),
      pairedAt: new Date().toISOString(),
      lastSynced: null,
      status: 'offline'
    };
    this.save();
    return this.data.peers[peerId];
  }

  removePeer(peerId) {
    if (this.data.peers[peerId]) {
      delete this.data.peers[peerId];
      this.save();
    }
  }

  updatePeer(peerId, fields) {
    if (this.data.peers[peerId]) {
      this.data.peers[peerId] = { ...this.data.peers[peerId], ...fields };
      this.save();
      return this.data.peers[peerId];
    }
    return null;
  }

  // Set custom database file (useful for running tests with temporary DB paths)
  setDbFileForTesting(testDbPath, testHomeDir) {
    // Make sure test directories exist
    if (!fs.existsSync(testHomeDir)) {
      fs.mkdirSync(testHomeDir, { recursive: true });
    }
    const testBackupsDir = path.join(testHomeDir, 'backups');
    if (!fs.existsSync(testBackupsDir)) {
      fs.mkdirSync(testBackupsDir, { recursive: true });
    }

    this.data.settings.dataDir = testHomeDir;
    this.data.settings.backupsDir = testBackupsDir;

    // Point DB file to test location
    // We override DB_FILE by rewriting the load/save target
    this._customDbFile = testDbPath;
    this.load();
  }

  // Helper to resolve actual DB path in use
  getDbFilePath() {
    return this._customDbFile || DB_FILE;
  }
}

// Singleton database instance
const db = new Database();
export default db;
