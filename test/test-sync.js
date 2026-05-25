import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceDir = path.resolve(__dirname, '..');

// Test folders
const testRootDir = path.join(workspaceDir, 'test_run');
const homeADir = path.join(testRootDir, 'home-a');
const homeBDir = path.join(testRootDir, 'home-b');
const gameASaveDir = path.join(testRootDir, 'game-saves-a');
const gameBSaveDir = path.join(testRootDir, 'game-saves-b');

const portA = 8391;
const portB = 8392;

// Clean up previous runs
function cleanup() {
  if (fs.existsSync(testRootDir)) {
    fs.rmSync(testRootDir, { recursive: true, force: true });
  }
}

// Ensure clean folders exist
function setupFolders() {
  fs.mkdirSync(testRootDir, { recursive: true });
  fs.mkdirSync(homeADir, { recursive: true });
  fs.mkdirSync(homeBDir, { recursive: true });
  fs.mkdirSync(gameASaveDir, { recursive: true });
  fs.mkdirSync(gameBSaveDir, { recursive: true });
}

// Helper to make API calls to daemons
async function apiCall(port, route, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : '';
    
    const options = {
      hostname: 'localhost',
      port: port,
      path: route,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': dataString.length
      }
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            data: JSON.parse(responseBody)
          });
        } catch (e) {
          resolve({ statusCode: res.statusCode, text: responseBody });
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (body) req.write(dataString);
    req.end();
  });
}

// Delay helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTest() {
  console.log('====================================================');
  console.log('Starting SaveSync Integrated P2P Sync Test...');
  console.log('====================================================');
  
  cleanup();
  setupFolders();

  const indexScript = path.join(workspaceDir, 'src/daemon/index.js');

  // Set environments for daemon processes to use mock directories
  // We point the HOME directories so they create separate db.json files!
  const envA = {
    ...process.env,
    USERPROFILE: homeADir,
    HOME: homeADir
  };

  const envB = {
    ...process.env,
    USERPROFILE: homeBDir,
    HOME: homeBDir
  };

  console.log(`[Test] Launching Daemon A on port ${portA}...`);
  const daemonA = spawn('node', [indexScript, '--port', portA.toString()], { env: envA });
  
  console.log(`[Test] Launching Daemon B on port ${portB}...`);
  const daemonB = spawn('node', [indexScript, '--port', portB.toString()], { env: envB });

  // Pipe logs to files for inspection
  const logA = fs.createWriteStream(path.join(testRootDir, 'daemon-a.log'));
  const logB = fs.createWriteStream(path.join(testRootDir, 'daemon-b.log'));
  daemonA.stdout.pipe(logA);
  daemonA.stderr.pipe(logA);
  daemonB.stdout.pipe(logB);
  daemonB.stderr.pipe(logB);

  // Wait for daemons to boot
  await sleep(3000);

  let success = false;

  try {
    // 1. Verify Status
    console.log('[Test] Verifying daemon health check APIs...');
    const statusA = await apiCall(portA, '/api/status');
    const statusB = await apiCall(portB, '/api/status');
    
    if (statusA.statusCode !== 200 || statusB.statusCode !== 200) {
      throw new Error('Daemons did not start up properly.');
    }
    console.log(`Daemon A Device Name: ${statusA.data.settings.deviceName}`);
    console.log(`Daemon B Device Name: ${statusB.data.settings.deviceName}`);

    // 2. Track "Dark Souls III" in Daemon A and Daemon B
    console.log('[Test] Tracking Game "Dark Souls III" in both daemons...');
    const addA = await apiCall(portA, '/api/games', 'POST', {
      name: 'Dark Souls III',
      savePath: gameASaveDir
    });

    const addB = await apiCall(portB, '/api/games', 'POST', {
      name: 'Dark Souls III',
      savePath: gameBSaveDir
    });

    if (addA.statusCode !== 201 || addB.statusCode !== 201) {
      throw new Error(`Failed to track game saves: A: ${addA.statusCode}, B: ${addB.statusCode}`);
    }

    const gameId = addA.data.id;
    console.log(`Game registered in Daemon A under ID: ${gameId}`);

    // 3. Initiate Handshake/Pairing
    console.log('[Test] Triggering pairing request from Daemon A to Daemon B...');
    const pairReq = await apiCall(portA, '/api/peers/pair', 'POST', {
      address: '127.0.0.1',
      port: portB
    });

    if (pairReq.statusCode !== 200) {
      throw new Error(`Pairing request failed: ${JSON.stringify(pairReq)}`);
    }

    // Wait for discovery & handshake request mapping
    await sleep(2000);

    // Approve the pairing on Daemon B
    console.log('[Test] Approving pairing request on Daemon B...');
    const listRequests = await apiCall(portB, '/api/peers');
    const pendingRequest = listRequests.data.requests[0];
    
    if (!pendingRequest) {
      throw new Error('No pending pairing request found on Daemon B.');
    }

    const approveReq = await apiCall(portB, '/api/peers/approve', 'POST', {
      peerId: pendingRequest.peerId
    });

    if (approveReq.statusCode !== 200) {
      throw new Error('Failed to approve peer pairing.');
    }
    console.log('Pairing successful! Nodes are linked.');

    // 4. Create mock save files in Peer A
    console.log('[Test] Writing save files into Peer A save directory...');
    fs.writeFileSync(path.join(gameASaveDir, 'DS30000.sl2'), 'DS3-CHARACTER-SAVE-LEVEL-15-CLAYMORE-BUILD');
    
    // Write a larger file (to test block chunking/delta transfer)
    const largeSavePath = path.join(gameASaveDir, 'large_save.dat');
    const size = 150 * 1024; // 150KB (requires 3 blocks: 64KB + 64KB + 22KB)
    const buffer = Buffer.alloc(size);
    buffer.write('BLOCK-0-INITIAL-DATA', 0);
    buffer.write('BLOCK-1-INITIAL-DATA', 64 * 1024);
    buffer.write('BLOCK-2-INITIAL-DATA', 128 * 1024);
    fs.writeFileSync(largeSavePath, buffer);

    console.log('[Test] Waiting for folder watcher to detect change and auto-snapshot (2s debounce)...');
    await sleep(4500); // 2s debounce + extra margin

    // Check if snapshot was automatically created on Daemon A
    const listGamesA = await apiCall(portA, '/api/games');
    const dsGameA = listGamesA.data[gameId];
    const snapCountA = dsGameA.branches.main.snapshots.length;
    
    if (snapCountA === 0) {
      throw new Error('Watcher failed to trigger auto-snapshot on save file change.');
    }
    console.log(`✔ Watcher auto-created snapshot. Total snapshots on Daemon A: ${snapCountA}`);

    // 5. Trigger P2P Sync (A to B)
    console.log('[Test] Triggering manual P2P Sync for game...');
    const syncRes = await apiCall(portA, `/api/games/${gameId}/sync`, 'POST');
    
    if (syncRes.statusCode !== 200) {
      throw new Error(`Sync call failed with status ${syncRes.statusCode}`);
    }

    await sleep(2000); // Wait for transfers to complete

    // 6. Verify replication on Daemon B
    console.log('[Test] Verifying file replication on Peer B...');
    const file1Exists = fs.existsSync(path.join(gameBSaveDir, 'DS30000.sl2'));
    const file2Exists = fs.existsSync(path.join(gameBSaveDir, 'large_save.dat'));

    if (!file1Exists || !file2Exists) {
      throw new Error('Files were not replicated in Peer B save directory.');
    }

    const file1Content = fs.readFileSync(path.join(gameBSaveDir, 'DS30000.sl2'), 'utf8');
    const file2Content = fs.readFileSync(path.join(gameBSaveDir, 'large_save.dat'));

    if (file1Content !== 'DS3-CHARACTER-SAVE-LEVEL-15-CLAYMORE-BUILD') {
      throw new Error('File content mismatch on replicated save file.');
    }
    console.log('✔ Files successfully replicated on Peer B!');

    // 7. Verify Delta Block Updates (modify file 2 block 1, leaving block 0 and 2 unchanged)
    console.log('[Test] Modifying only Block 1 of the large file to verify DELTA block transfer...');
    const fileBuffer = fs.readFileSync(largeSavePath);
    fileBuffer.write('BLOCK-1-UPDATED-CHARACTER-LEVEL-22-LOTHRIC-KNIGHT-SWORD', 64 * 1024);
    fs.writeFileSync(largeSavePath, fileBuffer);

    console.log('[Test] Waiting for Daemon A to snapshot modification...');
    await sleep(4500);

    console.log('[Test] Syncing delta modification...');
    const syncDeltaRes = await apiCall(portA, `/api/games/${gameId}/sync`, 'POST');
    
    if (syncDeltaRes.statusCode !== 200) {
      throw new Error('Syncing delta updates failed.');
    }
    await sleep(2000);

    // Verify replicated content matches the updated character state
    const peerBUpdatedBuffer = fs.readFileSync(path.join(gameBSaveDir, 'large_save.dat'));
    const block1String = peerBUpdatedBuffer.toString('utf8', 64 * 1024, 128 * 1024).replace(/\0/g, '');
    
    if (!block1String.includes('LOTHRIC-KNIGHT-SWORD')) {
      throw new Error(`Delta patch sync failed. Peer B content: ${block1String}`);
    }
    console.log('✔ Delta engine successfully synced only modified blocks. File correctly reconstructed on Peer B!');

    // 8. Rollback Test
    console.log('[Test] Testing rollback...');
    const listGamesBeforeRollback = await apiCall(portA, '/api/games');
    const snapshotsList = listGamesBeforeRollback.data[gameId].branches.main.snapshots;
    // Rollback to the first snapshot (Level 15 Claymore build, before delta block update)
    const originalSnapshotId = snapshotsList[0].id;

    console.log(`[Test] Restoring save to original state using snapshot: ${originalSnapshotId}...`);
    const rollbackRes = await apiCall(portA, `/api/games/${gameId}/rollback`, 'POST', {
      snapshotId: originalSnapshotId
    });

    if (rollbackRes.statusCode !== 200) {
      throw new Error('Rollback command failed.');
    }

    const currentFileContent = fs.readFileSync(largeSavePath);
    const block1Current = currentFileContent.toString('utf8', 64 * 1024, 128 * 1024).replace(/\0/g, '');
    
    if (block1Current.includes('LOTHRIC-KNIGHT-SWORD')) {
      throw new Error('Rollback failed to reset file content to original state.');
    }
    console.log('✔ Rollback reset the save state files successfully!');

    success = true;
    console.log('\n====================================================');
    console.log('✅ ALL INTEGRATED TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================');

  } catch (err) {
    console.error('\n❌ INTEGRATED TEST SUITE FAILED:', err.message);
  } finally {
    console.log('[Test] Stopping Daemon processes...');
    daemonA.kill('SIGTERM');
    daemonB.kill('SIGTERM');
    
    // Clear files if success
    if (success) {
      cleanup();
    } else {
      console.log(`[Test] Leaving logs and data in ${testRootDir} for debugging.`);
    }
    process.exit(success ? 0 : 1);
  }
}

runTest();
