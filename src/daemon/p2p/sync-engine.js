import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import db from '../db.js';
import { log } from '../logger.js';
import { getFolderManifest, diffManifests, patchFile, isSafePath } from '../delta.js';
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
    const nameParam = encodeURIComponent(game.name);
    const pathParam = encodeURIComponent(game.savePath);
    const remoteData = await this.p2pEngine.p2pRequest(peer, `/manifest/${gameId}?name=${nameParam}&savePath=${pathParam}`);
    
    // Check branch compatibility
    if (game.activeBranch !== remoteData.activeBranch) {
      log('warn', `Branch mismatch on "${game.name}" with "${peer.name}"`, `Local: "${game.activeBranch}", Remote: "${remoteData.activeBranch}". Swapping local to match.`);
      switchBranch(gameId, remoteData.activeBranch);
    }

    const localManifest = getFolderManifest(game.savePath);
    const remoteManifest = remoteData.manifest;

    const remoteLatestSnap = remoteData.latestSnapshot;

    const localFiles = localManifest.files || {};
    const remoteFiles = remoteManifest.files || {};
    const allFiles = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)]);

    // Load last known synced file list for this game/peer pair
    // This allows us to distinguish "deleted locally" vs "new on remote"
    const lastSyncedFiles = new Set(game.lastSyncedFilesByPeer?.[peer.id] || []);

    const filesToPull = [];
    const filesToPush = [];
    const filesToDeleteOnPeer = []; // files we deleted locally that peer still has
    const filesToDeleteLocally = []; // files peer deleted that we still have (peer will trigger delete on us via /delete-file)

    for (const relPath of allFiles) {
      const localFile = localFiles[relPath];
      const remoteFile = remoteFiles[relPath];

      if (remoteFile && !localFile) {
        // On remote, missing locally
        if (lastSyncedFiles.has(relPath)) {
          // Was in last sync — it was deleted locally → ask peer to delete it too
          filesToDeleteOnPeer.push(relPath);
        } else {
          // Was NOT in last sync — it's new on remote → pull it
          filesToPull.push(relPath);
        }
      } else if (localFile && !remoteFile) {
        // On local, missing remotely
        if (lastSyncedFiles.has(relPath)) {
          // Was in last sync — it was deleted on remote → delete locally too
          filesToDeleteLocally.push(relPath);
        } else {
          // Was NOT in last sync — it's new locally → push to remote
          filesToPush.push(relPath);
        }
      } else if (localFile && remoteFile && localFile.hash !== remoteFile.hash) {
        // Both have file, but different. Compare mtimes.
        const localMtime = localFile.mtime || 0;
        const remoteMtime = remoteFile.mtime || 0;

        if (remoteMtime > localMtime) {
          filesToPull.push(relPath);
        } else if (localMtime > remoteMtime) {
          filesToPush.push(relPath);
        } else {
          // Tie-breaker: pull from remote
          filesToPull.push(relPath);
        }
      }
    }

    const hasChanges = filesToPull.length > 0 || filesToPush.length > 0 || filesToDeleteOnPeer.length > 0 || filesToDeleteLocally.length > 0;

    if (!hasChanges) {
      log('success', `Peer "${peer.name}" is already in sync`, `Game: "${game.name}"`);
      // Refresh lastSyncedFiles even on no-change to ensure they're up to date
      const currentFileList = Object.keys(localFiles);
      const updatedSyncState = { ...(game.lastSyncedFilesByPeer || {}), [peer.id]: currentFileList };
      db.updateGame(gameId, { lastSyncedFilesByPeer: updatedSyncState });
      return { status: 'in_sync', direction: 'none' };
    }

    // Handle local deletions: delete files locally that peer deleted
    if (filesToDeleteLocally.length > 0) {
      log('event', 'Applying remote deletions', `Removing ${filesToDeleteLocally.length} file(s) deleted on peer "${peer.name}"`);
      for (const relPath of filesToDeleteLocally) {
        if (!isSafePath(game.savePath, relPath)) {
          log('warn', `Path traversal deletion denied: ${relPath}`);
          continue;
        }
        const fullPath = path.join(game.savePath, relPath);
        try {
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            log('info', `Deleted locally (peer deleted): ${relPath}`);
          }
        } catch (e) {
          log('warn', `Could not delete ${relPath}:`, e.message);
        }
      }
    }

    // Handle deletion propagation to peer: ask peer to delete files we deleted
    if (filesToDeleteOnPeer.length > 0) {
      log('event', 'Propagating local deletions', `Asking "${peer.name}" to delete ${filesToDeleteOnPeer.length} file(s)`);
      for (const relPath of filesToDeleteOnPeer) {
        if (!isSafePath(game.savePath, relPath)) {
          log('warn', `Path traversal deletion propagation denied: ${relPath}`);
          continue;
        }
        try {
          await this.p2pEngine.p2pRequest(peer, `/delete-file/${gameId}`, 'POST', { relPath });
          log('info', `Peer deleted: ${relPath}`);
        } catch (e) {
          log('warn', `Could not propagate deletion of ${relPath} to peer:`, e.message);
        }
      }
    }


    // 2. Pull remote files if needed
    if (filesToPull.length > 0) {
      // Ensure all remote directories exist locally
      const remoteDirs = remoteManifest.dirs || [];
      for (const dir of remoteDirs) {
        if (!isSafePath(game.savePath, dir)) {
          log('warn', `Path traversal directory creation denied: ${dir}`);
          continue;
        }
        const localDirPath = path.join(game.savePath, dir);
        if (!fs.existsSync(localDirPath)) {
          fs.mkdirSync(localDirPath, { recursive: true });
          log('info', `Created local directory: ${dir}`);
        }
      }

      log('event', 'Detected changes', `Remote save on "${peer.name}" has newer/different files. Pulling ${filesToPull.length} file(s)...`);

      // Pre-calculate total bytes to pull across all files and cache different blocks mapping
      let totalBytesToPull = 0;
      const fileDifferentBlocksMap = new Map();
      for (const relPath of filesToPull) {
        const remoteFileMeta = remoteFiles[relPath];
        let differentBlocks = [];
        const localFile = localFiles[relPath];

        if (!localFile) {
          differentBlocks = remoteFileMeta.blocks.map(b => b.index);
        } else {
          const remoteBlocks = remoteFileMeta.blocks || [];
          const localBlocks = localFile.blocks || [];
          const maxBlocks = Math.max(remoteBlocks.length, localBlocks.length);
          for (let i = 0; i < maxBlocks; i++) {
            const rBlock = remoteBlocks[i];
            const lBlock = localBlocks[i];
            if (!lBlock || !rBlock || lBlock.hash !== rBlock.hash) {
              differentBlocks.push(i);
            }
          }
        }
        fileDifferentBlocksMap.set(relPath, differentBlocks);

        for (const index of differentBlocks) {
          const blockMeta = remoteFileMeta.blocks[index];
          totalBytesToPull += blockMeta ? blockMeta.length : 64 * 1024;
        }
      }

      let bytesPulled = 0;
      const pullStart = Date.now();

      for (const relPath of filesToPull) {
        const remoteFileMeta = remoteFiles[relPath];
        const differentBlocks = fileDifferentBlocksMap.get(relPath) || [];

        log('event', 'Fetching blocks', `Fetching ${differentBlocks.length} block(s) for file: ${relPath}`);

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
          bytesPulled += bytesReceived;
          await this.throttle(bytesReceived, isWan);

          // Calculate speed and progress
          const elapsedTime = Date.now() - pullStart;
          const speedBytesPerSec = bytesPulled / (elapsedTime / 1000) || 0;
          const percentage = totalBytesToPull > 0 ? Math.min(100, Math.round((bytesPulled / totalBytesToPull) * 100)) : 100;

          // Broadcast sync progress
          if (typeof this.p2pEngine.onSyncProgress === 'function') {
            this.p2pEngine.onSyncProgress(gameId, {
              peerName: peer.name,
              bytesTransferred: bytesPulled,
              totalBytes: totalBytesToPull,
              speedBytesPerSec,
              percentage
            });
          }
        }

        // Patch file
        if (!isSafePath(game.savePath, relPath)) {
          throw new Error(`Access denied: path traversal attempt detected on pulled file ${relPath}`);
        }
        const localFilePath = path.join(game.savePath, relPath);
        patchFile(localFilePath, blockChunks, remoteFileMeta);

        // Update local modification time to match remote
        if (remoteFileMeta.mtime) {
          try {
            const time = remoteFileMeta.mtime / 1000;
            fs.utimesSync(localFilePath, time, time);
          } catch (e) {
            console.warn(`[Sync] Failed to set utime on ${localFilePath}:`, e.message);
          }
        }
        log('info', `File updated: ${relPath}`);
      }

      // Record snapshot locally mirroring the remote's latest snapshot state
      if (remoteLatestSnap) {
        const localBackupDir = path.join(db.getSettings().syncBackupsDir || db.getSettings().backupsDir, gameId, game.activeBranch);
        ensureDir(localBackupDir);
        
        const zipPath = path.join(localBackupDir, `${remoteLatestSnap.id}.zip`);
        
        const zip = new AdmZip();
        zip.addLocalFolder(game.savePath);
        zip.writeZip(zipPath);

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
    }

    // 3. Trigger peer pull if we have files to push
    if (filesToPush.length > 0) {
      log('event', 'Detected changes', `Local has newer/different files than remote "${peer.name}". Triggering peer pull.`);
      
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
    }

    if (filesToPull.length > 0 && filesToPush.length > 0) {
      log('success', 'Sync complete (bidirectional)', `Updated local from "${peer.name}" and triggered peer to pull`);
    } else if (filesToPull.length > 0) {
      log('success', 'Sync complete (pulled)', `Updated "${game.name}" from "${peer.name}"`);
    } else if (filesToDeleteLocally.length > 0 || filesToDeleteOnPeer.length > 0) {
      log('success', 'Sync complete (deletions applied)', `Synced deletions for "${game.name}" with "${peer.name}"`);
    } else {
      log('success', 'Sync complete (triggered push)', `Triggered "${peer.name}" to pull updates for "${game.name}"`);
    }

    // Save the current file list so future syncs can detect deletions
    const freshManifest = getFolderManifest(game.savePath);
    const currentFileList = Object.keys(freshManifest.files || {});
    const updatedSyncState = { ...(db.getGame(gameId).lastSyncedFilesByPeer || {}), [peer.id]: currentFileList };
    db.updateGame(gameId, { lastSyncedFilesByPeer: updatedSyncState });

    return {
      status: filesToPull.length > 0 && filesToPush.length > 0 ? 'updated_bidirectional'
        : filesToPull.length > 0 ? 'updated'
        : filesToDeleteLocally.length > 0 || filesToDeleteOnPeer.length > 0 ? 'deletions_synced'
        : 'triggered_peer_pull',
      direction: filesToPull.length > 0 && filesToPush.length > 0 ? 'bidirectional'
        : filesToPull.length > 0 ? 'pull'
        : 'push'
    };
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
        if (!isSafePath(game.savePath, relPath)) continue;
        const fullPath = path.join(game.savePath, relPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }

      const allModifiedFiles = [...diff.added, ...Object.keys(diff.modified)];
      for (const relPath of allModifiedFiles) {
        if (!isSafePath(game.savePath, relPath)) {
          throw new Error(`Access denied: path traversal attempt detected on conflict file ${relPath}`);
        }
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
        const localBackupDir = path.join(db.getSettings().syncBackupsDir || db.getSettings().backupsDir, gameId, game.activeBranch);
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
        if (!isSafePath(game.savePath, relPath)) continue;
        const fullPath = path.join(game.savePath, relPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }

      const allModifiedFiles = [...diff.added, ...Object.keys(diff.modified)];
      for (const relPath of allModifiedFiles) {
        if (!isSafePath(game.savePath, relPath)) {
          throw new Error(`Access denied: path traversal attempt detected on conflict file ${relPath}`);
        }
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
        const localBackupDir = path.join(db.getSettings().syncBackupsDir || db.getSettings().backupsDir, gameId, branchName);
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
