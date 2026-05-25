import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import zlib from 'zlib';
import AdmZip from 'adm-zip';
import { spawn } from 'child_process';

import db from './db.js';
import watcherEngine from './watcher.js';
import p2pEngine from './p2p.js';
import { setupWindowsFirewall } from './p2p/firewall.js';
import { createSnapshot, restoreSnapshot, createBranch, switchBranch } from './snapshot.js';
import { scanInstalledSaves } from './presets.js';
import relayManager from './relay-manager.js';
import { setBroadcastFn, getHistory, log } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
app.use(express.json());

// Serve static frontend assets
const frontendDir = path.join(__dirname, '../frontend');
app.use(express.static(frontendDir));

// Fallback index.html route for Single Page Application routing
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Setup standard HTTP server
const server = http.createServer(app);

// Setup WebSockets server for real-time UI dashboard broadcasts
const wss = new WebSocketServer({ server });
const connectedClients = new Set();

wss.on('connection', (ws) => {
  connectedClients.add(ws);
  
  // Send initial data immediately
  sendToClient(ws, 'init', {
    settings: db.getSettings(),
    games: db.getGames(),
    peers: db.getPeers(),
    discoveredPeers: p2pEngine.getDiscoveredPeers(),
    pairingRequests: p2pEngine.getPairingRequests(),
    wanRoom: p2pEngine.getWanRoomStatus(),
    activeConflicts: p2pEngine.activeConflicts,
    logHistory: getHistory()
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
  });
});

// Helper to broadcast events to all open Web UIs
function broadcast(event, data) {
  const payload = JSON.stringify({ event, data });
  for (const client of connectedClients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

setBroadcastFn(broadcast);

function sendToClient(ws, event, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ event, data }));
  }
}

// ----------------------------------------------------
// LOCAL DASHBOARD & CLI API ENDPOINTS
// ----------------------------------------------------

// System Status
app.get('/api/status', (req, res) => {
  res.json({
    settings: db.getSettings(),
    gamesCount: Object.keys(db.getGames()).length,
    peersCount: Object.keys(db.getPeers()).length
  });
});

// Window controllers bridge for frameless UI title bar
app.post('/api/window/minimize', (req, res) => {
  if (global.minimizeWindow) global.minimizeWindow();
  res.json({ success: true });
});

app.post('/api/window/maximize', (req, res) => {
  if (global.maximizeWindow) global.maximizeWindow();
  res.json({ success: true });
});

app.post('/api/window/close', (req, res) => {
  if (global.closeWindow) global.closeWindow();
  res.json({ success: true });
});

// Sync all games at once (triggered by System Tray click)
app.post('/api/games/sync-all', async (req, res) => {
  try {
    const games = db.getGames();
    const results = {};
    for (const gameId in games) {
      results[gameId] = await p2pEngine.syncGame(gameId);
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Settings (Relay server url, room syncCode, deviceName, hostRelay, relayPort, startOnBoot, speedLimit)
app.post('/api/settings', (req, res) => {
  try {
    const updateData = {};
    if (req.body.deviceName !== undefined) updateData.deviceName = req.body.deviceName;
    if (req.body.deviceType !== undefined) updateData.deviceType = req.body.deviceType;
    if (req.body.relayUrl !== undefined) updateData.relayUrl = req.body.relayUrl;
    if (req.body.syncCode !== undefined) updateData.syncCode = req.body.syncCode;
    if (req.body.hostRelay !== undefined) updateData.hostRelay = !!req.body.hostRelay;
    if (req.body.relayPort !== undefined) updateData.relayPort = parseInt(req.body.relayPort, 10) || 8386;
    if (req.body.startOnBoot !== undefined) updateData.startOnBoot = !!req.body.startOnBoot;
    if (req.body.speedLimit !== undefined) updateData.speedLimit = parseInt(req.body.speedLimit, 10) || 0;

    const updated = db.updateSettings(updateData);
    const settings = db.getSettings();
    
    // Connect/Reconnect WAN Relay client immediately with new settings
    p2pEngine.connectToRelay();

    // Toggle local in-process WAN relay server
    if (settings.hostRelay) {
      relayManager.start(settings.relayPort || 8386);
    } else {
      relayManager.stop();
    }

    // Update startup registry settings if running in Electron
    if (global.updateStartupSettings && updateData.startOnBoot !== undefined) {
      global.updateStartupSettings(settings.startOnBoot);
    }

    // Broadcast updated init state to all dashboard clients
    broadcast('init', {
      settings: db.getSettings(),
      games: db.getGames(),
    peers: db.getPeers(),
    discoveredPeers: p2pEngine.getDiscoveredPeers(),
    pairingRequests: p2pEngine.getPairingRequests(),
    wanRoom: p2pEngine.getWanRoomStatus()
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan installed emulator / repack game save directories
app.get('/api/presets/scan', async (req, res) => {
  try {
    const discovered = await scanInstalledSaves();
    res.json(discovered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Native folder browse dialog bridge
app.get('/api/browse-directory', async (req, res) => {
  if (global.selectDirectoryCallback) {
    try {
      const selectedPath = await global.selectDirectoryCallback();
      res.json({ path: selectedPath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(400).json({ error: 'Directory browser is only available when running in the Desktop App window.' });
  }
});

// Native file browse dialog bridge (for executable path)
app.get('/api/browse-file', async (req, res) => {
  if (global.selectFileCallback) {
    try {
      const selectedPath = await global.selectFileCallback();
      res.json({ path: selectedPath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(400).json({ error: 'File browser is only available when running in the Desktop App window.' });
  }
});

// Get IP addresses for local hosting dashboard
app.get('/api/relay/ips', async (req, res) => {
  try {
    const localIps = relayManager.getLocalIps();
    const publicIp = await relayManager.getPublicIp();
    res.json({ localIps, publicIp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current WAN relay room connection state
app.get('/api/wan/status', (req, res) => {
  res.json(p2pEngine.getWanRoomStatus());
});

// Probe configured relay HTTP /health endpoint
// Returns relay stats if reachable; error object if not
app.get('/api/relay/health', async (req, res) => {
  const settings  = db.getSettings();
  let relayUrl    = settings.relayUrl || '';

  // Convert ws(s):// → http(s):// for HTTP health probe
  const httpUrl = relayUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://');

  try {
    const response = await fetch(`${httpUrl}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      return res.status(502).json({ reachable: false, error: `Relay returned HTTP ${response.status}` });
    }
    const data = await response.json();
    res.json({ reachable: true, relayUrl, ...data });
  } catch (err) {
    res.status(504).json({
      reachable: false,
      relayUrl,
      error: `Cannot reach relay at ${httpUrl}/health — ${err.message}`
    });
  }
});

// Get all games
app.get('/api/games', (req, res) => {
  res.json(db.getGames());
});

// Add game
app.post('/api/games', (req, res) => {
  const { name, savePath } = req.body;
  if (!name || !savePath) {
    return res.status(400).json({ error: 'Name and Save Path are required.' });
  }

  try {
    const game = db.addGame(name, savePath);
    // Register file watcher
    watcherEngine.watchGame(game);
    // Broadcast state update to UI
    broadcast('games-update', db.getGames());
    res.status(201).json(game);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove game
app.delete('/api/games/:gameId', (req, res) => {
  const { gameId } = req.params;
  try {
    watcherEngine.unwatchGame(gameId);
    db.removeGame(gameId);
    broadcast('games-update', db.getGames());
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Update game launch and configuration settings
app.patch('/api/games/:gameId', (req, res) => {
  const { gameId } = req.params;
  const { appId, exePath, coverUrl, savePath } = req.body;
  try {
    const fields = {};
    if (appId !== undefined) fields.appId = appId ? appId.trim() : '';
    if (exePath !== undefined) fields.exePath = exePath ? exePath.trim() : '';
    if (coverUrl !== undefined) fields.coverUrl = coverUrl ? coverUrl.trim() : '';
    if (savePath !== undefined && savePath) {
      fields.savePath = path.resolve(savePath);
      // Update watcher if path changed
      const game = db.getGame(gameId);
      if (game && game.savePath !== fields.savePath) {
        watcherEngine.unwatchGame(gameId);
        const updatedGame = { ...game, savePath: fields.savePath };
        watcherEngine.watchGame(updatedGame);
      }
    }
    
    const updated = db.updateGame(gameId, fields);
    broadcast('games-update', db.getGames());
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Launch a game
app.post('/api/games/:gameId/launch', async (req, res) => {
  const { gameId } = req.params;
  const game = db.getGame(gameId);
  if (!game) {
    return res.status(404).json({ error: 'Game not found.' });
  }

  try {
    if (game.appId) {
      log('info', `Launching Steam game: ${game.name}`, `(AppID: ${game.appId})`);
      if (global.openExternalUrl) {
        await global.openExternalUrl(`steam://run/${game.appId}`);
      } else {
        const cmd = process.platform === 'win32' ? 'start' : 'open';
        spawn(cmd, [`steam://run/${game.appId}`], { shell: true, detached: true });
      }
      return res.json({ success: true, method: 'steam' });
    } else if (game.exePath) {
      if (!fs.existsSync(game.exePath)) {
        throw new Error(`Executable path not found: ${game.exePath}`);
      }
      log('info', `Launching custom executable: ${game.name}`, `(Path: ${game.exePath})`);
      const workingDir = path.dirname(game.exePath);
      const child = spawn(game.exePath, [], {
        cwd: workingDir,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return res.json({ success: true, method: 'exe' });
    } else {
      throw new Error('No AppID or executable path configured for this game.');
    }
  } catch (err) {
    log('error', `Failed to launch ${game.name}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Trigger manual snapshot
app.post('/api/games/:gameId/snapshot', (req, res) => {
  const { gameId } = req.params;
  const { comment } = req.body;
  try {
    const snap = createSnapshot(gameId, comment, false);
    broadcast('games-update', db.getGames());
    res.json({ success: true, snapshot: snap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger rollback
app.post('/api/games/:gameId/rollback', (req, res) => {
  const { gameId } = req.params;
  const { snapshotId } = req.body;
  try {
    const snap = restoreSnapshot(gameId, snapshotId);
    broadcast('games-update', db.getGames());
    res.json({ success: true, restored: snap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create branch
app.post('/api/games/:gameId/branch', (req, res) => {
  const { gameId } = req.params;
  const { branchName } = req.body;
  try {
    const branch = createBranch(gameId, branchName);
    broadcast('games-update', db.getGames());
    res.json({ success: true, branch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Switch branch
app.post('/api/games/:gameId/branch/switch', (req, res) => {
  const { gameId } = req.params;
  const { branchName } = req.body;
  try {
    switchBranch(gameId, branchName);
    broadcast('games-update', db.getGames());
    res.json({ success: true, activeBranch: branchName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve a save version conflict
app.post('/api/games/:gameId/resolve-conflict', async (req, res) => {
  const { gameId } = req.params;
  const { peerId, resolution } = req.body;
  if (!peerId || !resolution) {
    return res.status(400).json({ error: 'peerId and resolution are required.' });
  }
  try {
    const result = await p2pEngine.resolveConflict(gameId, peerId, resolution);
    broadcast('games-update', db.getGames());
    broadcast('peers-update', {
      paired: db.getPeers(),
      discovered: p2pEngine.getDiscoveredPeers(),
      requests: p2pEngine.getPairingRequests(),
      wanRoom: p2pEngine.getWanRoomStatus()
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Highly compressed global backup exporter (.sscb format)
app.post('/api/backup/export', async (req, res) => {
  const { exportDir } = req.body;
  if (!exportDir) {
    return res.status(400).json({ error: 'Export destination directory is required.' });
  }

  try {
    if (!fs.existsSync(exportDir)) {
      return res.status(400).json({ error: 'Destination directory does not exist.' });
    }

    const games = db.getGames();
    const gameList = Object.values(games);
    if (gameList.length === 0) {
      return res.status(400).json({ error: 'No games are currently tracked. Nothing to backup.' });
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const backupFolderName = `${timestamp}-savesync-backup`;
    const backupFolderPath = path.join(exportDir, backupFolderName);

    // Create backup folder
    fs.mkdirSync(backupFolderPath, { recursive: true });

    const report = {
      timestamp: now.toISOString(),
      backupFolder: backupFolderPath,
      gamesBackedUp: []
    };

    let totalOriginalBytes = 0;
    let totalCompressedBytes = 0;

    for (const game of gameList) {
      if (!fs.existsSync(game.savePath)) {
        continue;
      }

      // 1. Pack the game's active save folder into a store-only zip file buffer
      const zip = new AdmZip();
      
      // Calculate uncompressed size
      let originalSizeBytes = 0;
      const calculateSize = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            calculateSize(fullPath);
          } else {
            originalSizeBytes += stat.size;
          }
        }
      };
      try {
        calculateSize(game.savePath);
      } catch (e) {}

      zip.addLocalFolder(game.savePath);
      const zipBuffer = zip.toBuffer();

      // 2. Compress the zip buffer using Brotli (max ratio quality 9)
      const compressedBuffer = zlib.brotliCompressSync(zipBuffer, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 9
        }
      });

      // 3. Write individual file [Game Label].sscb
      const safeGameName = game.name.replace(/[^a-zA-Z0-9_\- ]/g, '_');
      const sscbFileName = `${safeGameName}.sscb`;
      const sscbFilePath = path.join(backupFolderPath, sscbFileName);
      fs.writeFileSync(sscbFilePath, compressedBuffer);

      const compressedSizeBytes = compressedBuffer.length;
      totalOriginalBytes += originalSizeBytes;
      totalCompressedBytes += compressedSizeBytes;

      const savingPercent = originalSizeBytes > 0 
        ? Math.round((1 - (compressedSizeBytes / originalSizeBytes)) * 100) 
        : 100;

      report.gamesBackedUp.push({
        gameId: game.id,
        name: game.name,
        fileName: sscbFileName,
        originalSize: originalSizeBytes,
        compressedSize: compressedSizeBytes,
        savings: `${savingPercent}%`
      });
    }

    // Write metadata JSON file inside the backup folder
    const metadataPath = path.join(backupFolderPath, 'backup-metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(report, null, 2), 'utf8');

    res.json({
      success: true,
      backupFolder: backupFolderName,
      backupPath: backupFolderPath,
      totalOriginal: totalOriginalBytes,
      totalCompressed: totalCompressedBytes,
      savings: totalOriginalBytes > 0 ? `${Math.round((1 - (totalCompressedBytes / totalOriginalBytes)) * 100)}%` : '100%',
      details: report.gamesBackedUp
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore a backup folder (.sscb files) back to original save paths
app.post('/api/backup/restore', async (req, res) => {
  const { backupPath } = req.body;
  if (!backupPath) {
    return res.status(400).json({ error: 'backupPath is required.' });
  }

  try {
    if (!fs.existsSync(backupPath)) {
      return res.status(400).json({ error: 'Backup folder does not exist.' });
    }

    // Read metadata file for original save paths
    const metadataPath = path.join(backupPath, 'backup-metadata.json');
    if (!fs.existsSync(metadataPath)) {
      return res.status(400).json({ error: 'No backup-metadata.json found in folder. This may not be a valid SaveSync backup.' });
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const games = db.getGames();
    const results = [];

    for (const backed of metadata.gamesBackedUp) {
      const sscbPath = path.join(backupPath, backed.fileName);
      if (!fs.existsSync(sscbPath)) {
        results.push({ name: backed.name, status: 'skipped', reason: 'File not found in backup folder' });
        continue;
      }

      // Find the tracked game to get original save path
      const trackedGame = games[backed.gameId] || Object.values(games).find(g => g.name === backed.name);
      if (!trackedGame) {
        results.push({ name: backed.name, status: 'skipped', reason: 'Game not tracked. Add it first then restore.' });
        continue;
      }

      try {
        // 1. Decompress the Brotli buffer
        const compressedBuffer = fs.readFileSync(sscbPath);
        const zipBuffer = zlib.brotliDecompressSync(compressedBuffer);

        // 2. Extract zip into a temp directory, then copy to actual save path
        const zip = new AdmZip(zipBuffer);
        const targetDir = trackedGame.savePath;

        // Ensure target directory exists
        fs.mkdirSync(targetDir, { recursive: true });

        // 3. Extract zip entries to target path
        zip.extractAllTo(targetDir, true /* overwrite */);

        results.push({ name: backed.name, status: 'restored', path: targetDir });
      } catch (extractErr) {
        results.push({ name: backed.name, status: 'error', reason: extractErr.message });
      }
    }

    const restored = results.filter(r => r.status === 'restored').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;

    // Broadcast games update so the UI refreshes
    broadcast('games-update', db.getGames());

    res.json({ success: true, restored, skipped, errors, details: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger manual synchronization with peers
app.post('/api/games/:gameId/sync', async (req, res) => {
  const { gameId } = req.params;
  try {
    broadcast('sync-start', { gameId, message: 'Syncing game saves with peers...' });
    const result = await p2pEngine.syncGame(gameId);
    broadcast('games-update', db.getGames());
    broadcast('sync-complete', { gameId, result });
    res.json(result);
  } catch (err) {
    broadcast('sync-error', { gameId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Endpoint called by peer to trigger sync in reverse
app.get('/api/sync/trigger/:gameId', (req, res) => {
  const { gameId } = req.params;
  const originPeerName = req.query.originPeer || 'a remote peer';
  console.log(`[Sync] Sync trigger received for game "${gameId}" requested by ${originPeerName}.`);
  
  // Asynchronously perform sync
  p2pEngine.syncGame(gameId)
    .then((result) => {
      broadcast('games-update', db.getGames());
      broadcast('sync-complete', { gameId, result });
    })
    .catch((err) => {
      console.error('[Sync] Triggered sync failed:', err.message);
    });

  res.status(200).json({ success: true, message: 'Sync triggered.' });
});

// Get peers (paired, discovered, requests)
app.get('/api/peers', (req, res) => {
  res.json({
    paired: db.getPeers(),
    discovered: p2pEngine.getDiscoveredPeers(),
    requests: p2pEngine.getPairingRequests(),
    wanRoom: p2pEngine.getWanRoomStatus()
  });
});

// Probe a direct IP target before sending a pairing request
app.post('/api/peers/probe', async (req, res) => {
  const { address, port } = req.body;
  if (!address || !port) {
    return res.status(400).json({ error: 'Address and Port are required.' });
  }

  try {
    const response = await fetch(`http://${address}:${port}/api/p2p/ping`, {
      signal: AbortSignal.timeout(4000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || `Peer returned HTTP ${response.status}` });
    }
    res.json({
      reachable: true,
      address,
      port,
      deviceName: data.deviceName || 'Unknown Device',
      deviceType: data.deviceType || 'desktop'
    });
  } catch (err) {
    res.status(504).json({
      reachable: false,
      error: `Could not reach SaveSync at ${address}:${port}. Check the IP, port, network profile, and firewall.`
    });
  }
});

// Outbound pair request
app.post('/api/peers/pair', async (req, res) => {
  const { address, port, isWan, targetPeerId } = req.body;
  if (!address || (!isWan && !port)) {
    return res.status(400).json({ error: 'Address and Port are required.' });
  }

  try {
    const result = await p2pEngine.pairWithPeer(address, port, isWan, targetPeerId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve pairing request
app.post('/api/peers/approve', (req, res) => {
  const { peerId } = req.body;
  try {
    const peer = p2pEngine.approvePairing(peerId);
    broadcast('peers-update', {
      paired: db.getPeers(),
      discovered: p2pEngine.getDiscoveredPeers(),
      requests: p2pEngine.getPairingRequests(),
      wanRoom: p2pEngine.getWanRoomStatus()
    });
    res.json({ success: true, peer });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reject/Ignore pairing request
app.post('/api/peers/reject', (req, res) => {
  const { peerId } = req.body;
  p2pEngine.rejectPairing(peerId);
  broadcast('peers-update', {
    paired: db.getPeers(),
    discovered: p2pEngine.getDiscoveredPeers(),
    requests: p2pEngine.getPairingRequests(),
    wanRoom: p2pEngine.getWanRoomStatus()
  });
  res.json({ success: true });
});

// Remove pairing
app.delete('/api/peers/:peerId', (req, res) => {
  const { peerId } = req.params;
  db.removePeer(peerId);
  broadcast('peers-update', {
    paired: db.getPeers(),
    discovered: p2pEngine.getDiscoveredPeers(),
    requests: p2pEngine.getPairingRequests(),
    wanRoom: p2pEngine.getWanRoomStatus()
  });
  res.json({ success: true });
});

// ----------------------------------------------------
// P2P INTER-DAEMON API ENDPOINTS
// ----------------------------------------------------
p2pEngine.registerRoutes(app);

// ----------------------------------------------------
// ENGINE BROADCAST SYNC HOOKS
// ----------------------------------------------------
// Register callback in folder watcher: when folder watcher finishes writing
// an automatic save snapshot, it calls this to trigger P2P syncing to all online peers!
watcherEngine.setSyncCallback((gameId, snapshot) => {
  broadcast('games-update', db.getGames());
  broadcast('sync-start', { gameId, message: 'Auto-syncing changed files with peers...' });
  
  p2pEngine.syncGame(gameId)
    .then((result) => {
      broadcast('games-update', db.getGames());
      broadcast('sync-complete', { gameId, result });
    })
    .catch((err) => {
      console.error('[Watcher Sync Hook] Peer sync failed:', err.message);
      broadcast('sync-error', { gameId, error: err.message });
    });
});

// Periodically broadcast peer list changes to Dashboard
setInterval(() => {
  broadcast('peers-update', {
    paired: db.getPeers(),
    discovered: p2pEngine.getDiscoveredPeers(),
    requests: p2pEngine.getPairingRequests(),
    wanRoom: p2pEngine.getWanRoomStatus()
  });
}, 3000);

// ----------------------------------------------------
// SERVER STARTUP
// ----------------------------------------------------
const args = process.argv.slice(2);
let port = db.getSettings().port;

const portIndex = args.indexOf('--port');
if (portIndex !== -1 && args[portIndex + 1]) {
  port = parseInt(args[portIndex + 1], 10);
}

// Host configuration (can be local-only or bind to all interfaces)
const host = '0.0.0.0';

server.listen(port, host, () => {
  log('info', 'SaveSync Daemon Started!', `Dashboard: http://localhost:${port}`);
  log('info', `P2P Node Address: Binding to all interfaces on port ${port}`);
  
  // Start database and engines
  p2pEngine.init(port);
  setupWindowsFirewall();
  p2pEngine.onPeerUpdate = () => {
    broadcast('peers-update', {
      paired: db.getPeers(),
      discovered: p2pEngine.getDiscoveredPeers(),
      requests: p2pEngine.getPairingRequests(),
      wanRoom: p2pEngine.getWanRoomStatus()
    });
  };
  watcherEngine.start();

  // Start in-process relay server if enabled in settings
  const settings = db.getSettings();
  if (settings.hostRelay) {
    relayManager.start(settings.relayPort || 8386);
  }
});

// Graceful Shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('\n[Daemon] Shutting down SaveSync daemon...');
  watcherEngine.stop();
  p2pEngine.stopDiscovery();
  server.close(() => {
    console.log('[Daemon] HTTP Server stopped. Exit.');
    process.exit(0);
  });
}
export default server;
