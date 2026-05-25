import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import db from '../db.js';
import { log } from '../logger.js';
import { getFolderManifest, diffManifests, patchFile } from '../delta.js';
import { getLatestSnapshot, switchBranch, createBranch } from '../snapshot.js';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export class SyncEngine {
  constructor(p2pEngine) {
    this.p2pEngine = p2pEngine;
  }

  async throttle(bytesTransferred, isWan) {
    if (bytesTransferred <= 0) return;
    const settings = db.getSettings();
    if (isWan && settings.speedLimit > 0) {
      const limitBytesPerSec = settings.speedLimit * 1024;
      const delayMs = (bytesTransferred * 1000) / limitBytesPerSec;
      if (delayMs > 50) {
        log('info', `Bandwidth Limit Active`, `Pausing for ${Math.round(delayMs)}ms (${(bytesTransferred / 1024).toFixed(1)} KB downloaded, limit: ${settings.speedLimit} KB/s)`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  // Synchronize a game with all online, paired peers
  async syncGame(gameId) {
    if (this.p2pEngine.activeSyncs[gameId]) {
      return { status: 'skipped', message: 'Sync already running.' };
    }

    const game = db.getGame(gameId);
    if (!game) throw new Error(`Game ${gameId} not found.`);

    await this.p2pEngine.pingPairedPeers();

    const peers = db.getPeers();
    const onlinePeers = Object.values(peers).filter(p => p.status === 'online');

    if (onlinePeers.length === 0) {
      return { status: 'no_peers', message: 'No online peers available.' };
    }

    this.p2pEngine.activeSyncs[gameId] = true;
    log('info', `Starting sync for "${game.name}"`, `with ${onlinePeers.length} online peer(s)`);

    const syncReport = {
      gameId,
      peersSynced: [],
      errors: []
    };

    try {
      for (const peer of onlinePeers) {
        try {
          const report = await this.syncWithSpecificPeer(gameId, peer);
          syncReport.peersSynced.push({ peerName: peer.name, ...report });
          db.updatePeer(peer.id, { lastSynced: new Date().toISOString() });
        } catch (peerErr) {
          log('error', `Failed syncing "${game.name}" with "${peer.name}"`, peerErr.message);
          syncReport.errors.push({ peerName: peer.name, error: peerErr.message });
        }
      }
    } finally {
      this.p2pEngine.activeSyncs[gameId] = false;
    }

    return syncReport;
  }

  // Peer-to-peer sync protocol implementation using unified p2pRequest helper
  async syncWithSpecificPeer(gameId, peer) {
    const game = db.getGame(gameId);
    log('info', `Syncing "${game.name}" with "${peer.name}"`, `${peer.address === 'relay' ? 'WAN Relay' : 'Direct LAN'}`);

    // 1. Fetch remote manifest & branch info
    const remoteData = await this.p2pEngine.p2pRequest(peer, `/manifest/${gameId}`);
    
    // Check branch compatibility
    if (game.activeBranch !== remoteData.activeBranch) {
      log('warn', `Branch mismatch on "${game.name}" with "${peer.name}"`, `Local: "${game.activeBranch}", Remote: "${remoteData.activeBranch}". Swapping local to match.`);
      switchBranch(gameId, remoteData.activeBranch);
    }

    const localManifest = getFolderManifest(game.savePath);
    const remoteManifest = remoteData.manifest;

    // Compare latest snapshots to determine who has the newer save
    const localLatestSnap = getLatestSnapshot(gameId);
    const remoteLatestSnap = remoteData.latestSnapshot;

    const localTime = localLatestSnap ? new Date(localLatestSnap.timestamp).getTime() : 0;
    const remoteTime = remoteLatestSnap ? new Date(remoteLatestSnap.timestamp).getTime() : 0;

    // Diverged History / Conflict check:
    if (localLatestSnap && remoteLatestSnap && localLatestSnap.id !== remoteLatestSnap.id) {
      const branch = game.branches[game.activeBranch];
      const localSnapshots = branch ? branch.snapshots : [];
      const isRemoteInLocalHistory = localSnapshots.some(s => s.id === remoteLatestSnap.id);
      
      const remoteHistory = remoteData.history || [];
      const isLocalInRemoteHistory = remoteHistory.includes(localLatestSnap.id);

      if (!isRemoteInLocalHistory && !isLocalInRemoteHistory) {
        log('error', `Diverged history conflict detected`, `Game: "${game.name}" with peer "${peer.name}"`);
        this.p2pEngine.activeConflicts[gameId] = {
          peer,
          localSnap: localLatestSnap,
          remoteSnap: remoteLatestSnap
        };
        return {
          status: 'conflict',
          peerName: peer.name,
          peerId: peer.id,
          localSnap: localLatestSnap,
          remoteSnap: remoteLatestSnap
        };
      }
    }

    if (localTime === remoteTime) {
      log('success', `Peer "${peer.name}" is already in sync`, `Game: "${game.name}"`);
      return { status: 'in_sync', direction: 'none' };
    }

    if (localTime > remoteTime) {
      log('event', `Detected changes`, `Local is newer than remote "${peer.name}" for "${game.name}". Requesting peer pull.`);
      
      if (peer.address === 'relay' || peer.isWan) {
        // Trigger WAN peer pull via WebSocket message
        this.p2pEngine.wanClient.sendRelayMessage({
          type: 'request',
          to: peer.id,
          from: this.p2pEngine.getLocalPeerId(),
          route: `/sync/trigger/${gameId}`,
          method: 'GET'
        });
      } else {
        // Trigger direct LAN pull via HTTP get
        fetch(`http://${peer.address}:${peer.port}/api/sync/trigger/${gameId}?originPeer=${db.getSettings().deviceName}`, {
          signal: AbortSignal.timeout(5000)
        }).catch(() => {});
      }
      return { status: 'triggered_peer_pull', direction: 'push' };
    }

    // Remote is newer! We need to pull from remote.
    log('event', 'Detected changes', `Remote save on "${peer.name}" is newer for "${game.name}". Pulling changes...`);

    // 2. Perform delta diff
    const diff = diffManifests(localManifest, remoteManifest);
    log('event', 'Compressing delta', `Delta diff calculated: ${diff.added.length} added, ${Object.keys(diff.modified).length} modified, ${diff.deleted.length} deleted`);

    // 3. Process deletions
    for (const relPath of diff.deleted) {
      const fullPath = path.join(game.savePath, relPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        log('info', `Deleted local file: ${relPath}`);
      }
    }

    // 4. Process additions and modifications
    const allModifiedFiles = [...diff.added, ...Object.keys(diff.modified)];

    for (const relPath of allModifiedFiles) {
      const remoteFileMeta = remoteManifest.files[relPath];
      let differentBlocks = [];
      if (diff.added.includes(relPath)) {
        differentBlocks = remoteFileMeta.blocks.map(b => b.index);
      } else {
        differentBlocks = diff.modified[relPath].differentBlocks;
      }

      log('event', 'Encrypting payload', `Fetching ${differentBlocks.length} block(s) for file: ${relPath}`);

      const blockChunks = [];
      const isWan = peer.address === 'relay' || peer.isWan;
      const batchSize = isWan ? 8 : 16;

      for (let i = 0; i < differentBlocks.length; i += batchSize) {
        const batchIndices = differentBlocks.slice(i, i + batchSize);
        const blockData = await this.p2pEngine.p2pRequest(peer, `/blocks/${gameId}`, 'POST', { relPath, blockIndices: batchIndices });
        blockChunks.push(...blockData.blocks);

        let bytesReceived = 0;
        for (const block of blockData.blocks) {
          bytesReceived += block.length;
        }
        await this.throttle(bytesReceived, isWan);
      }

      // Reconstruct/patch the file
      const localFilePath = path.join(game.savePath, relPath);
      patchFile(localFilePath, blockChunks, remoteFileMeta);
      log('info', `File updated: ${relPath}`);
    }

    // 5. Retrieve local snapshot files
    if (remoteLatestSnap) {
      const localBackupDir = path.join(db.getSettings().backupsDir, gameId, game.activeBranch);
      ensureDir(localBackupDir);
      
      const zipPath = path.join(localBackupDir, `${remoteLatestSnap.id}.zip`);
      
      // Zip the newly updated save folder
      const zip = new AdmZip();
      zip.addLocalFolder(game.savePath);
      zip.writeZip(zipPath);

      // Save snapshot to local database history
      const branches = game.branches || {};
      if (!branches[game.activeBranch]) {
        branches[game.activeBranch] = { name: game.activeBranch, snapshots: [] };
      }
      
      if (!branches[game.activeBranch].snapshots.some(s => s.id === remoteLatestSnap.id)) {
        branches[game.activeBranch].snapshots.push({
          id: remoteLatestSnap.id,
          timestamp: remoteLatestSnap.timestamp,
          comment: `Synced from peer: ${peer.name} (${remoteLatestSnap.comment})`,
          isSystemAuto: true,
          zipPath,
          sizeBytes: fs.statSync(zipPath).size,
          branch: game.activeBranch
        });
        db.updateGame(gameId, { branches });
      }
    }

    log('success', 'Sync complete', `Updated "${game.name}" from "${peer.name}"`);
    return { status: 'updated', direction: 'pull' };
  }

  // Conflict resolution handler
  async resolveConflict(gameId, peerId, resolution) {
    const conflict = this.p2pEngine.activeConflicts[gameId];
    if (!conflict || conflict.peer.id !== peerId) {
      throw new Error('No active conflict found for this game and peer.');
    }

    const game = db.getGame(gameId);
    if (!game) throw new Error('Game not found.');

    const peer = conflict.peer;

    if (resolution === 'keep-local') {
      console.log(`[Sync] Conflict resolved by keeping LOCAL save. Triggering peer "${peer.name}" to pull from us.`);
      
      if (peer.address === 'relay' || peer.isWan) {
        this.p2pEngine.wanClient.sendRelayMessage({
          type: 'request',
          to: peer.id,
          from: this.p2pEngine.getLocalPeerId(),
          route: `/sync/trigger/${gameId}`,
          method: 'GET'
        });
      } else {
        fetch(`http://${peer.address}:${peer.port}/api/sync/trigger/${gameId}?originPeer=${db.getSettings().deviceName}`, {
          signal: AbortSignal.timeout(5000)
        }).catch(() => {});
      }
      delete this.p2pEngine.activeConflicts[gameId];
      return { success: true, resolution: 'keep-local' };

    } else if (resolution === 'keep-remote') {
      console.log(`[Sync] Conflict resolved by keeping REMOTE save. Overwriting local with remote saves.`);
      
      const remoteData = await this.p2pEngine.p2pRequest(peer, `/manifest/${gameId}`);
      const localManifest = getFolderManifest(game.savePath);
      const remoteManifest = remoteData.manifest;

      const diff = diffManifests(localManifest, remoteManifest);
      
      for (const relPath of diff.deleted) {
        const fullPath = path.join(game.savePath, relPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }

      const allModifiedFiles = [...diff.added, ...Object.keys(diff.modified)];
      for (const relPath of allModifiedFiles) {
        const remoteFileMeta = remoteManifest.files[relPath];
        let differentBlocks = [];
        if (diff.added.includes(relPath)) {
          differentBlocks = remoteFileMeta.blocks.map(b => b.index);
        } else {
          differentBlocks = diff.modified[relPath].differentBlocks;
        }

        const isWan = peer.address === 'relay' || peer.isWan;
        const blockChunks = [];
        const batchSize = isWan ? 8 : 16;

        for (let i = 0; i < differentBlocks.length; i += batchSize) {
          const batchIndices = differentBlocks.slice(i, i + batchSize);
          const blockData = await this.p2pEngine.p2pRequest(peer, `/blocks/${gameId}`, 'POST', { relPath, blockIndices: batchIndices });
          blockChunks.push(...blockData.blocks);

          let bytesReceived = 0;
          for (const block of blockData.blocks) {
            bytesReceived += block.length;
          }
          await this.throttle(bytesReceived, isWan);
        }

        const localFilePath = path.join(game.savePath, relPath);
        patchFile(localFilePath, blockChunks, remoteFileMeta);
      }

      const remoteLatestSnap = remoteData.latestSnapshot;
      if (remoteLatestSnap) {
        const localBackupDir = path.join(db.getSettings().backupsDir, gameId, game.activeBranch);
        ensureDir(localBackupDir);
        const zipPath = path.join(localBackupDir, `${remoteLatestSnap.id}.zip`);
        
        const zip = new AdmZip();
        zip.addLocalFolder(game.savePath);
        zip.writeZip(zipPath);

        const branches = game.branches || {};
        if (!branches[game.activeBranch].snapshots.some(s => s.id === remoteLatestSnap.id)) {
          branches[game.activeBranch].snapshots.push({
            id: remoteLatestSnap.id,
            timestamp: remoteLatestSnap.timestamp,
            comment: `Synced from peer: ${peer.name} (Resolved conflict: Overwrite with remote)`,
            isSystemAuto: true,
            zipPath,
            sizeBytes: fs.statSync(zipPath).size,
            branch: game.activeBranch
          });
          db.updateGame(gameId, { branches });
        }
      }

      delete this.p2pEngine.activeConflicts[gameId];
      return { success: true, resolution: 'keep-remote' };

    } else if (resolution === 'merge-branch') {
      const branchName = `conflict-${peer.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now().toString().substr(-4)}`;
      console.log(`[Sync] Conflict resolved by keeping BOTH saves. Pulling remote saves into new branch: "${branchName}".`);

      createBranch(gameId, branchName);
      switchBranch(gameId, branchName);

      const remoteData = await this.p2pEngine.p2pRequest(peer, `/manifest/${gameId}`);
      const localManifest = getFolderManifest(game.savePath);
      const remoteManifest = remoteData.manifest;

      const diff = diffManifests(localManifest, remoteManifest);
      for (const relPath of diff.deleted) {
        const fullPath = path.join(game.savePath, relPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }

      const allModifiedFiles = [...diff.added, ...Object.keys(diff.modified)];
      for (const relPath of allModifiedFiles) {
        const remoteFileMeta = remoteManifest.files[relPath];
        let differentBlocks = [];
        if (diff.added.includes(relPath)) {
          differentBlocks = remoteFileMeta.blocks.map(b => b.index);
        } else {
          differentBlocks = diff.modified[relPath].differentBlocks;
        }

        const isWan = peer.address === 'relay' || peer.isWan;
        const blockChunks = [];
        const batchSize = isWan ? 8 : 16;

        for (let i = 0; i < differentBlocks.length; i += batchSize) {
          const batchIndices = differentBlocks.slice(i, i + batchSize);
          const blockData = await this.p2pEngine.p2pRequest(peer, `/blocks/${gameId}`, 'POST', { relPath, blockIndices: batchIndices });
          blockChunks.push(...blockData.blocks);

          let bytesReceived = 0;
          for (const block of blockData.blocks) {
            bytesReceived += block.length;
          }
          await this.throttle(bytesReceived, isWan);
        }

        const localFilePath = path.join(game.savePath, relPath);
        patchFile(localFilePath, blockChunks, remoteFileMeta);
      }

      const remoteLatestSnap = remoteData.latestSnapshot;
      if (remoteLatestSnap) {
        const localBackupDir = path.join(db.getSettings().backupsDir, gameId, branchName);
        ensureDir(localBackupDir);
        const zipPath = path.join(localBackupDir, `${remoteLatestSnap.id}.zip`);
        
        const zip = new AdmZip();
        zip.addLocalFolder(game.savePath);
        zip.writeZip(zipPath);

        const branches = game.branches || {};
        branches[branchName].snapshots.push({
          id: remoteLatestSnap.id,
          timestamp: remoteLatestSnap.timestamp,
          comment: `Diverged save state from peer: ${peer.name}`,
          isSystemAuto: true,
          zipPath,
          sizeBytes: fs.statSync(zipPath).size,
          branch: branchName
        });
        db.updateGame(gameId, { branches });
      }

      delete this.p2pEngine.activeConflicts[gameId];
      return { success: true, resolution: 'merge-branch', branchName };
    }

    throw new Error('Invalid conflict resolution type.');
  }
}
