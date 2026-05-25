import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getFolderManifest, readBlocks, translatePathToLocal } from '../delta.js';
import { getLatestSnapshot } from '../snapshot.js';
import watcherEngine from '../watcher.js';

export function registerExpressRoutes(app, p2pEngine) {
  app.get('/api/p2p/ping', (req, res) => {
    res.status(200).json({
      status: 'ok',
      deviceName: db.getSettings().deviceName,
      deviceType: db.getSettings().deviceType || 'desktop',
      games: p2pEngine.getLocalGamesState()
    });
  });

  app.post('/api/p2p/approve-confirm', (req, res) => {
    const { peerId, deviceName, deviceType, port } = req.body;
    let clientIp = req.ip.replace('::ffff:', '');
    if (clientIp === '::1' || clientIp === '127.0.0.1') clientIp = 'localhost';
    
    db.addPeer(peerId, deviceName, clientIp, port, deviceType || 'desktop');
    db.updatePeer(peerId, { status: 'online', lastSeen: Date.now() });

    if (typeof p2pEngine.onPeerUpdate === 'function') {
      p2pEngine.onPeerUpdate();
    }

    res.status(200).json({ success: true, message: 'Pairing confirmed.' });
  });

  app.post('/api/p2p/handshake', (req, res) => {
    const { peerId, deviceName, deviceType, port } = req.body;
    let clientIp = req.ip.replace('::ffff:', '');
    if (clientIp === '::1') clientIp = 'localhost';

    p2pEngine.pairingRequests[peerId] = {
      peerId,
      deviceName,
      deviceType: deviceType || 'desktop',
      address: clientIp,
      port,
      isWan: false
    };

    if (typeof p2pEngine.onPeerUpdate === 'function') {
      p2pEngine.onPeerUpdate();
    }

    res.status(200).json({ status: 'pending', message: 'Pairing request received. Waiting for host approval.' });
  });

  app.post('/api/p2p/unpair', (req, res) => {
    const { peerId } = req.body;
    db.removePeer(peerId);
    if (typeof p2pEngine.onPeerUpdate === 'function') {
      p2pEngine.onPeerUpdate();
    }
    res.status(200).json({ success: true, message: 'Unpaired successfully.' });
  });

  app.get('/api/p2p/manifest/:gameId', (req, res) => {
    const { gameId } = req.params;
    let game = db.getGame(gameId);
    if (!game) {
      const { name, savePath } = req.query;
      if (name && savePath) {
        try {
          const localSavePath = translatePathToLocal(savePath);
          console.log(`[P2P] Auto-tracking game "${name}" at "${localSavePath}" (original: "${savePath}") requested by peer.`);
          if (!fs.existsSync(localSavePath)) {
            fs.mkdirSync(localSavePath, { recursive: true });
          }
          game = db.addGame(name, localSavePath);
          watcherEngine.watchGame(game);
        } catch (err) {
          return res.status(400).json({ error: `Auto-track failed: ${err.message}` });
        }
      } else {
        return res.status(404).json({ error: 'Game not found.' });
      }
    }
    try {
      const activeBranchObj = game.branches[game.activeBranch];
      res.status(200).json({
        gameId,
        activeBranch: game.activeBranch,
        latestSnapshot: getLatestSnapshot(gameId),
        manifest: getFolderManifest(game.savePath),
        history: activeBranchObj ? activeBranchObj.snapshots.map(s => s.id) : []
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/p2p/blocks/:gameId', (req, res) => {
    const { gameId } = req.params;
    const { relPath, blockIndices } = req.body;
    const game = db.getGame(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found.' });
    try {
      const fullPath = path.join(game.savePath, relPath);
      res.status(200).json({ relPath, blocks: readBlocks(fullPath, blockIndices) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/p2p/snapshot/:gameId/:snapshotId', (req, res) => {
    const { gameId, snapshotId } = req.params;
    const game = db.getGame(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found.' });

    let snapshot = null;
    for (const b in game.branches) {
      const snap = game.branches[b].snapshots.find(s => s.id === snapshotId);
      if (snap) {
        snapshot = snap;
        break;
      }
    }

    if (!snapshot || !fs.existsSync(snapshot.zipPath)) {
      return res.status(404).json({ error: 'Snapshot ZIP file not found.' });
    }
    res.download(snapshot.zipPath);
  });

  // Peer requests deletion of a specific file (for deletion sync)
  app.post('/api/p2p/delete-file/:gameId', (req, res) => {
    const { gameId } = req.params;
    const { relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'relPath is required.' });
    
    const game = db.getGame(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found.' });

    try {
      // Security: ensure relPath doesn't escape the save directory
      const fullPath = path.join(game.savePath, relPath);
      const resolvedPath = path.resolve(fullPath);
      const resolvedSave = path.resolve(game.savePath);
      if (!resolvedPath.startsWith(resolvedSave + path.sep) && resolvedPath !== resolvedSave) {
        return res.status(403).json({ error: 'Path traversal denied.' });
      }

      if (fs.existsSync(resolvedPath)) {
        const stat = fs.statSync(resolvedPath);
        if (stat.isDirectory()) {
          fs.rmSync(resolvedPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(resolvedPath);
        }
        console.log(`[P2P] Deleted file at peer request: ${relPath} (game: ${gameId})`);
      }
      res.status(200).json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
