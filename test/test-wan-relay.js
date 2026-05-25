import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceDir = path.resolve(__dirname, '..');

// Test folder pathways
const testRootDir = path.join(workspaceDir, 'test_run_wan');
const homeADir = path.join(testRootDir, 'home-a');
const homeBDir = path.join(testRootDir, 'home-b');
const gameASaveDir = path.join(testRootDir, 'game-saves-a');
const gameBSaveDir = path.join(testRootDir, 'game-saves-b');

const portA = 8393;
const portB = 8394;
const relayPort = 8386;

function cleanup() {
  if (fs.existsSync(testRootDir)) {
    fs.rmSync(testRootDir, { recursive: true, force: true });
  }
}

function setupFolders() {
  fs.mkdirSync(testRootDir, { recursive: true });
  fs.mkdirSync(homeADir, { recursive: true });
  fs.mkdirSync(homeBDir, { recursive: true });
  fs.mkdirSync(gameASaveDir, { recursive: true });
  fs.mkdirSync(gameBSaveDir, { recursive: true });
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWanTest() {
  console.log('====================================================');
  console.log('Starting SaveSync WAN Relay Synchronization Test...');
  console.log('====================================================');
  
  cleanup();
  setupFolders();

  const relayScript = path.join(workspaceDir, 'src/relay-server.js');
  const indexScript = path.join(workspaceDir, 'src/daemon/index.js');

  // 1. Launch Relay Server
  console.log(`[Test] Launching WAN Relay Server on port ${relayPort}...`);
  const relayServer = spawn('node', [relayScript]);
  const logRelay = fs.createWriteStream(path.join(testRootDir, 'relay.log'));
  relayServer.stdout.pipe(logRelay);
  relayServer.stderr.pipe(logRelay);

  await sleep(1500);

  // 2. Launch Daemon processes with custom mock environments
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

  const logA = fs.createWriteStream(path.join(testRootDir, 'daemon-a.log'));
  const logB = fs.createWriteStream(path.join(testRootDir, 'daemon-b.log'));
  daemonA.stdout.pipe(logA);
  daemonA.stderr.pipe(logA);
  daemonB.stdout.pipe(logB);
  daemonB.stderr.pipe(logB);

  await sleep(3000);

  let success = false;

  try {
    // Check daemon health
    const statusA = await apiCall(portA, '/api/status');
    const statusB = await apiCall(portB, '/api/status');
    if (statusA.statusCode !== 200 || statusB.statusCode !== 200) {
      throw new Error('Daemons did not start properly.');
    }

    // 3. Configure syncCode in both daemons to join the same relay room
    console.log('[Test] Configuring WAN sync room codes on Peer A and Peer B...');
    const setSettingsA = await apiCall(portA, '/api/settings', 'POST', {
      deviceName: 'Device-A-WAN',
      relayUrl: 'ws://localhost:8386',
      syncCode: 'wan-test-room-99'
    });

    const setSettingsB = await apiCall(portB, '/api/settings', 'POST', {
      deviceName: 'Device-B-WAN',
      relayUrl: 'ws://localhost:8386',
      syncCode: 'wan-test-room-99'
    });

    if (setSettingsA.statusCode !== 200 || setSettingsB.statusCode !== 200) {
      throw new Error('Failed to save settings/room codes.');
    }

    // Wait for connection to relay and presence broadcasts
    console.log('[Test] Waiting for WS Relay room discovery exchanges...');
    await sleep(4000);

    // 4. Verify discovery occurred in Daemon A's list
    const listPeersA = await apiCall(portA, '/api/peers');
    const discoveredPeer = listPeersA.data.discovered.find(p => p.address === 'relay');
    if (!discoveredPeer) {
      throw new Error('Daemon A did not discover Daemon B through the WAN relay.');
    }
    console.log(`✔ Discovery succeeded! Daemon A found WAN Peer: ${discoveredPeer.deviceName}`);

    // 5. Trigger Handshake over WAN
    console.log('[Test] Initiating pairing handshake request over WAN...');
    const pairReq = await apiCall(portA, '/api/peers/pair', 'POST', {
      address: 'relay',
      port: 0,
      isWan: true
    });

    if (pairReq.statusCode !== 200) {
      throw new Error('WAN pairing request failed.');
    }

    await sleep(2000);

    // Approve request on Daemon B
    console.log('[Test] Approving pairing request on Daemon B...');
    const listPeersB = await apiCall(portB, '/api/peers');
    const pendingRequest = listPeersB.data.requests[0];
    if (!pendingRequest) {
      throw new Error('No pending request found on Daemon B.');
    }

    const approveReq = await apiCall(portB, '/api/peers/approve', 'POST', {
      peerId: pendingRequest.peerId
    });

    if (approveReq.statusCode !== 200) {
      throw new Error('WAN pairing approval failed.');
    }

    await sleep(2000);
    console.log('✔ Symmetric WAN pairing link established!');

    // 6. Register Mock game in both daemons
    console.log('[Test] Tracking Game "Celeste" in both daemons...');
    const addGameA = await apiCall(portA, '/api/games', 'POST', { name: 'Celeste', savePath: gameASaveDir });
    const addGameB = await apiCall(portB, '/api/games', 'POST', { name: 'Celeste', savePath: gameBSaveDir });
    const gameId = addGameA.data.id;

    // Allow chokidar watcher to initialize
    await sleep(2500);

    // 7. Write save files in A
    console.log('[Test] Writing save files into Peer A Celeste directory...');
    fs.writeFileSync(path.join(gameASaveDir, '0.celeste'), 'CELESTE-SAVE-FILE-CHAPTER-7-COMPLETED');

    console.log('[Test] Waiting for watcher auto-snapshot...');
    await sleep(4500); // watcher settles

    // 8. Trigger WAN Synchronization
    console.log('[Test] Triggering WAN P2P Sync on Daemon A...');
    const syncRes = await apiCall(portA, `/api/games/${gameId}/sync`, 'POST');
    if (syncRes.statusCode !== 200) {
      throw new Error(`WAN Sync API failed: status ${syncRes.statusCode}`);
    }

    await sleep(3000); // wait for WebSocket transfers to settle

    // 9. Verify replication on B
    console.log('[Test] Verifying file replication on Peer B Celeste directory...');
    const celSavePath = path.join(gameBSaveDir, '0.celeste');
    if (!fs.existsSync(celSavePath)) {
      throw new Error('Save file was not replicated on Peer B over WAN WebSocket Relay.');
    }

    const celContent = fs.readFileSync(celSavePath, 'utf8');
    if (celContent !== 'CELESTE-SAVE-FILE-CHAPTER-7-COMPLETED') {
      throw new Error('Save file content mismatch on WAN replicated file.');
    }

    success = true;
    console.log('\n====================================================');
    console.log('✅ ALL WAN WEBSOCKET RELAY TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================');

  } catch (err) {
    console.error('\n❌ WAN INTEGRATION TEST FAILED:', err.message);
  } finally {
    console.log('[Test] Stopping all background processes...');
    daemonA.kill('SIGTERM');
    daemonB.kill('SIGTERM');
    relayServer.kill('SIGTERM');

    await sleep(2000);

    if (success) {
      cleanup();
    } else {
      console.log(`[Test] Leaving logs and data in ${testRootDir} for debugging.`);
    }
    process.exit(success ? 0 : 1);
  }
}

runWanTest();
