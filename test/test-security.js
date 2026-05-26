import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import http from 'http';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceDir = path.resolve(__dirname, '..');

// Test folders
const testRootDir = path.join(workspaceDir, 'test_run_security');
const homeADir = path.join(testRootDir, 'home-a');
const homeBDir = path.join(testRootDir, 'home-b');
const gameASaveDir = path.join(testRootDir, 'game-saves-a');
const gameBSaveDir = path.join(testRootDir, 'game-saves-b');

const portA = 8395;
const portB = 8396;

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

// Get first active external IPv4 address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name]) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) {
        return info.address;
      }
    }
  }
  return '127.0.0.1'; // Fallback
}

// Helper to make API calls to daemons
async function apiCall(hostname, port, route, method = 'GET', body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : '';
    
    const headers = {
      'Content-Type': 'application/json',
      ...extraHeaders
    };
    if (body) {
      headers['Content-Length'] = Buffer.byteLength(dataString);
    }
    
    const options = {
      hostname: hostname,
      port: port,
      path: route,
      method: method,
      headers: headers
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

async function runSecurityTests() {
  console.log('====================================================');
  console.log('Starting SaveSync Security Hardening Test Suite...');
  console.log('====================================================');
  
  cleanup();
  setupFolders();

  const localIp = getLocalIp();
  console.log(`[Test] Active Local LAN IP: ${localIp}`);

  const indexScript = path.join(workspaceDir, 'src/daemon/index.js');

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

  // Wait for daemons to boot
  await sleep(3000);

  let allPassed = true;

  try {
    // ----------------------------------------------------
    // TEST 1: CORS Origin Defense
    // ----------------------------------------------------
    console.log('\n[Test 1] Verifying CORS Policy Defense...');
    const corsRes = await apiCall('localhost', portA, '/api/status', 'GET', null, {
      'Origin': 'http://evil-attacker.com'
    });
    
    if (corsRes.statusCode === 403) {
      console.log('✔ PASS: Request from malicious Origin was successfully blocked with 403 Forbidden!');
    } else {
      console.error(`❌ FAIL: Request from malicious Origin was NOT blocked (got ${corsRes.statusCode})`);
      allPassed = false;
    }

    // ----------------------------------------------------
    // TEST 2: Localhost Dashboard REST API Restrictions
    // ----------------------------------------------------
    console.log('\n[Test 2] Verifying Localhost-Only Dashboard REST API Restriction...');
    if (localIp === '127.0.0.1') {
      console.log('⚠ SKIP: Local LAN IP matches loopback. Cannot reliably test external LAN IP blocking locally.');
    } else {
      const extDashboardRes = await apiCall(localIp, portA, '/api/status', 'GET');
      if (extDashboardRes.statusCode === 403) {
        console.log('✔ PASS: Request to dashboard API from external LAN IP was successfully blocked with 403 Forbidden!');
      } else {
        console.error(`❌ FAIL: Dashboard API was accessible from external LAN IP (got ${extDashboardRes.statusCode})`);
        allPassed = false;
      }
    }

    // ----------------------------------------------------
    // SETUP: Register game for testing
    // ----------------------------------------------------
    const addGameA = await apiCall('localhost', portA, '/api/games', 'POST', {
      name: 'Dark Souls III',
      savePath: gameASaveDir
    });
    const gameId = addGameA.data.id;
    console.log(`\n[Test Setup] Game tracked under ID: ${gameId}`);

    // ----------------------------------------------------
    // TEST 3: Unpaired LAN Access Prevention
    // ----------------------------------------------------
    console.log('\n[Test 3] Verifying Unpaired LAN Access Block...');
    if (localIp === '127.0.0.1') {
      console.log('⚠ SKIP: Local LAN IP matches loopback. Cannot reliably test unpaired LAN IP blocking locally.');
    } else {
      const unpairedRes = await apiCall(localIp, portA, `/api/p2p/manifest/${gameId}`, 'GET');
      if (unpairedRes.statusCode === 401) {
        console.log('✔ PASS: Unpaired peer requesting manifest was successfully blocked with 401 Unauthorized!');
      } else {
        console.error(`❌ FAIL: Unpaired peer retrieved manifest (got ${unpairedRes.statusCode})`);
        allPassed = false;
      }
    }

    // ----------------------------------------------------
    // TEST 4: Unsolicited approve-confirm pairing exploit
    // ----------------------------------------------------
    console.log('\n[Test 4] Verifying Unsolicited approve-confirm pairing block...');
    const unsolicitedRes = await apiCall(localIp, portA, '/api/p2p/approve-confirm', 'POST', {
      peerId: 'attacker-peer-id',
      deviceName: 'Attacker Machine',
      deviceType: 'desktop',
      port: 8399
    });
    
    if (unsolicitedRes.statusCode === 400) {
      console.log('✔ PASS: Unsolicited approve-confirm was successfully blocked with 400 Bad Request!');
    } else {
      console.error(`❌ FAIL: Unsolicited approve-confirm succeeded or returned unexpected code (got ${unsolicitedRes.statusCode})`);
      allPassed = false;
    }

    // ----------------------------------------------------
    // PAIR DEVICES: Authenticate/Pair Daemon A and Daemon B
    // ----------------------------------------------------
    console.log('\n[Test Setup] Pairing Daemon A and Daemon B...');
    const pairReq = await apiCall('localhost', portA, '/api/peers/pair', 'POST', {
      address: localIp,
      port: portB
    });
    if (pairReq.statusCode !== 200) {
      throw new Error(`Failed to send handshake from A to B: ${JSON.stringify(pairReq)}`);
    }
    await sleep(1500);

    const listRequests = await apiCall('localhost', portB, '/api/peers');
    const pendingRequest = listRequests.data.requests[0];
    if (!pendingRequest) {
      throw new Error('No pending pairing request found on B.');
    }

    const approveReq = await apiCall('localhost', portB, '/api/peers/approve', 'POST', {
      peerId: pendingRequest.peerId
    });
    if (approveReq.statusCode !== 200) {
      throw new Error('Failed to approve peer pairing on B.');
    }
    console.log('Pairing confirmed between Daemon A and Daemon B.');
    await sleep(1500);

    // ----------------------------------------------------
    // TEST 5: Paired Peer Access Approval
    // ----------------------------------------------------
    console.log('\n[Test 5] Verifying Paired LAN Access Allowed...');
    if (localIp === '127.0.0.1') {
      console.log('⚠ SKIP: Local LAN IP matches loopback. Cannot reliably test paired LAN access locally.');
    } else {
      const pairedRes = await apiCall(localIp, portA, `/api/p2p/manifest/${gameId}`, 'GET');
      if (pairedRes.statusCode === 200) {
        console.log('✔ PASS: Paired peer retrieved manifest successfully!');
      } else {
        console.error(`❌ FAIL: Paired peer request failed with status: ${pairedRes.statusCode}`);
        allPassed = false;
      }
    }

    // ----------------------------------------------------
    // TEST 6: Path Traversal Block on Blocks Endpoint
    // ----------------------------------------------------
    console.log('\n[Test 6] Verifying Path Traversal Block on /api/p2p/blocks/:gameId...');
    const traversalRes = await apiCall('localhost', portA, `/api/p2p/blocks/${gameId}`, 'POST', {
      relPath: '../../unauthorized_file.txt',
      blockIndices: [0]
    });

    if (traversalRes.statusCode === 403) {
      console.log('✔ PASS: Path traversal block request was successfully blocked with 403 Forbidden!');
    } else {
      console.error(`❌ FAIL: Path traversal block request succeeded or returned unexpected code (got ${traversalRes.statusCode})`);
      allPassed = false;
    }

    // ----------------------------------------------------
    // TEST 7: Path Traversal Block on Delete Endpoint
    // ----------------------------------------------------
    console.log('\n[Test 7] Verifying Path Traversal Block on /api/p2p/delete-file/:gameId...');
    const deleteTraversalRes = await apiCall('localhost', portA, `/api/p2p/delete-file/${gameId}`, 'POST', {
      relPath: '../../unauthorized_file.txt'
    });

    if (deleteTraversalRes.statusCode === 403) {
      console.log('✔ PASS: Path traversal delete request was successfully blocked with 403 Forbidden!');
    } else {
      console.error(`❌ FAIL: Path traversal delete request succeeded or returned unexpected code (got ${deleteTraversalRes.statusCode})`);
      allPassed = false;
    }

  } catch (err) {
    console.error('\n❌ Error during security test execution:', err.message);
    allPassed = false;
  } finally {
    console.log('\n[Test] Stopping Daemon processes...');
    daemonA.kill('SIGTERM');
    daemonB.kill('SIGTERM');
    
    if (allPassed) {
      cleanup();
      console.log('\n====================================================');
      console.log('✅ ALL SECURITY HARDENING TESTS PASSED SUCCESSFULLY!');
      console.log('====================================================');
      process.exit(0);
    } else {
      console.log(`\n❌ SECURITY HARDENING TESTS FAILED.`);
      console.log(`[Test] Leaving logs and data in ${testRootDir} for debugging.`);
      process.exit(1);
    }
  }
}

runSecurityTests();
