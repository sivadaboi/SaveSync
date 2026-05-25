#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import db from '../src/daemon/db.js';
import { createSnapshot, restoreSnapshot, createBranch, switchBranch } from '../src/daemon/snapshot.js';
import { scanInstalledSaves } from '../src/daemon/presets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = db.getSettings().port;
const API_URL = `http://localhost:${PORT}/api`;
const PID_FILE = path.join(db.getSettings().dataDir, 'daemon.pid');

const args = process.argv.slice(2);
const command = args[0];

// ANSI codes for console styling
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const PURPLE = '\x1b[35m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

const asciiArt = `
${PURPLE}${BOLD}   ____                     ____                  
  / ___|  __ ___   _____   / ___| _   _ _ __   ___ 
  \\___ \\ / _\` \\ \\ / / _ \\  \\___ \\| | | | '_ \\ / __|
   ___) | (_| |\\ V /  __/   ___) | |_| | | | | (__ 
  |____/ \\__,_| \\_/ \\___|  |____/ \\__, |_| |_|\\___|
                                  |___/            
${CYAN}         Universal P2P Game Save Sync Engine${RESET}
`;

// Helper to check if daemon is running
async function isDaemonRunning() {
  try {
    const res = await fetch(`${API_URL}/status`);
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'init':
      handleInit();
      break;
    case 'add':
      await handleAdd(args[1], args[2]);
      break;
    case 'status':
      await handleStatus();
      break;
    case 'sync':
      await handleSync(args[1]);
      break;
    case 'snapshot':
      await handleSnapshot(args[1], args[2]);
      break;
    case 'rollback':
      await handleRollback(args[1], args[2]);
      break;
    case 'branch':
      await handleBranch(args[1], args[2]);
      break;
    case 'checkout':
      await handleCheckout(args[1], args[2]);
      break;
    case 'scan':
      await handleScan();
      break;
    case 'pair-code':
      await handlePairCode(args[1]);
      break;
    case 'daemon':
      await handleDaemon(args[1], args[2] === '--port' ? args[3] : null);
      break;
    default:
      console.log(`${RED}Unknown command: ${command}${RESET}`);
      printHelp();
  }
}

function printHelp() {
  console.log(asciiArt);
  console.log(`${BOLD}Usage:${RESET} savesync <command> [arguments]`);
  console.log('\n');
  console.log(`${BOLD}Core Commands:${RESET}`);
  console.log(`  ${GREEN}init${RESET}                                   Initialize SaveSync local setup`);
  console.log(`  ${GREEN}add <Game Name> <Save Path>${RESET}           Track a new game or custom folder path`);
  console.log(`  ${GREEN}scan${RESET}                                   Scan system for installed game & emulator saves`);
  console.log(`  ${GREEN}status${RESET}                                 View monitored games, branches, and peers`);
  console.log(`  ${GREEN}sync [Game ID]${RESET}                         Sync game save(s) with active peers`);
  console.log(`  ${GREEN}snapshot <Game ID> "[Comment]"${RESET}         Create a manual snapshot backup`);
  console.log(`  ${GREEN}rollback <Game ID> <Snapshot ID>${RESET}       Restore save folder to a specific snapshot`);
  console.log(`  ${GREEN}branch <Game ID> <Branch Name>${RESET}         Create a new save branch`);
  console.log(`  ${GREEN}checkout <Game ID> <Branch Name>${RESET}       Switch to a save branch`);
  console.log(`  ${GREEN}pair-code <code>${RESET}                       Pair with another device using a WAN Sync Code`);
  console.log('\n');
  console.log(`${BOLD}Daemon Commands:${RESET}`);
  console.log(`  ${GREEN}daemon start [--port <port>]${RESET}           Start SaveSync background service`);
  console.log(`  ${GREEN}daemon stop${RESET}                            Stop SaveSync background service`);
}

function handleInit() {
  console.log(asciiArt);
  const settings = db.getSettings();
  console.log(`${GREEN}✔ SaveSync database initialized successfully!${RESET}`);
  console.log(`${BOLD}Storage Directory:${RESET} ${settings.dataDir}`);
  console.log(`${BOLD}Backup Directory:${RESET} ${settings.backupsDir}`);
  console.log(`${BOLD}Device Name:${RESET} ${settings.deviceName}`);
  console.log(`${BOLD}Default Port:${RESET} ${settings.port}`);
  console.log(`\nTo start the background daemon, run: ${CYAN}savesync daemon start${RESET}`);
}

async function handleAdd(name, savePath) {
  if (!name || !savePath) {
    console.log(`${RED}Error: Game name and save directory path are required.${RESET}`);
    console.log(`Example: ${CYAN}savesync add "Dark Souls III" "C:\\Users\\Siva Prakash\\Documents\\My Games\\DarkSoulsIII"${RESET}`);
    return;
  }

  const running = await isDaemonRunning();
  if (running) {
    try {
      const response = await fetch(`${API_URL}/games`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, savePath })
      });
      const data = await response.json();
      if (response.ok) {
        console.log(`${GREEN}✔ Game "${data.name}" added and monitored in real-time by the daemon! (ID: ${data.id})${RESET}`);
      } else {
        console.log(`${RED}Error: ${data.error}${RESET}`);
      }
    } catch (e) {
      console.log(`${RED}Failed to contact daemon: ${e.message}${RESET}`);
    }
  } else {
    // Modify database directly
    try {
      const game = db.addGame(name, savePath);
      console.log(`${GREEN}✔ Game "${game.name}" added to configuration! (ID: ${game.id})${RESET}`);
      console.log(`${YELLOW}⚠ Note: The daemon is currently offline. Start the daemon to monitor folder changes: ${CYAN}savesync daemon start${RESET}`);
    } catch (err) {
      console.log(`${RED}Error: ${err.message}${RESET}`);
    }
  }
}

async function handleStatus() {
  console.log(asciiArt);
  const running = await isDaemonRunning();
  console.log(`${BOLD}Service Status:${RESET} ${running ? `${GREEN}Online` : `${RED}Offline`}${RESET}`);
  console.log(`${BOLD}API Link:${RESET} http://localhost:${PORT}`);
  console.log('\n----------------------------------------');
  
  const games = db.getGames();
  console.log(`${BOLD}Monitored Games (${Object.keys(games).length}):${RESET}`);
  for (const id in games) {
    const game = games[id];
    const branch = game.branches[game.activeBranch];
    const snapCount = branch?.snapshots?.length || 0;
    console.log(`- ${BOLD}${game.name}${RESET} (ID: ${id})`);
    console.log(`  Path: ${game.savePath}`);
    console.log(`  Active Branch: ${PURPLE}${game.activeBranch}${RESET} (${snapCount} snapshots)`);
  }

  console.log('\n----------------------------------------');
  const peers = db.getPeers();
  const paired = Object.values(peers);
  console.log(`${BOLD}Paired Devices (${paired.length}):${RESET}`);
  for (const peer of paired) {
    console.log(`- ${peer.name} (${peer.address}:${peer.port}) - Status: ${peer.status === 'online' ? `${GREEN}online` : `${RED}offline`}${RESET}`);
  }
}

async function handleSync(gameId = null) {
  const running = await isDaemonRunning();
  if (!running) {
    console.log(`${RED}Error: Daemon must be running to sync with peers.${RESET}`);
    console.log(`Start daemon using: ${CYAN}savesync daemon start${RESET}`);
    return;
  }

  if (gameId) {
    console.log(`Synchronizing game ${gameId}...`);
    try {
      const res = await fetch(`${API_URL}/games/${gameId}/sync`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        console.log(`${GREEN}✔ Sync operation complete!${RESET}`);
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`${RED}Sync failed: ${data.error}${RESET}`);
      }
    } catch (e) {
      console.log(`${RED}Error: ${e.message}${RESET}`);
    }
  } else {
    console.log('Synchronizing all games...');
    const games = db.getGames();
    for (const id in games) {
      console.log(`Syncing ${games[id].name}...`);
      try {
        const res = await fetch(`${API_URL}/games/${id}/sync`, { method: 'POST' });
        const data = await res.json();
        console.log(`- [${games[id].name}]: ${data.status || 'Done'} (${data.message || 'Complete'})`);
      } catch (e) {
        console.log(`- [${games[id].name}]: ${RED}Error (${e.message})${RESET}`);
      }
    }
  }
}

async function handleSnapshot(gameId, comment = '') {
  if (!gameId) {
    console.log(`${RED}Error: Game ID is required.${RESET}`);
    return;
  }

  const running = await isDaemonRunning();
  if (running) {
    try {
      const res = await fetch(`${API_URL}/games/${gameId}/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment })
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`${GREEN}✔ Snapshot created: ${data.snapshot.id} (${data.snapshot.comment})${RESET}`);
      } else {
        console.log(`${RED}Error: ${data.error}${RESET}`);
      }
    } catch (e) {
      console.log(`${RED}Error connecting to daemon: ${e.message}${RESET}`);
    }
  } else {
    try {
      const snap = createSnapshot(gameId, comment, false);
      console.log(`${GREEN}✔ Snapshot created offline: ${snap.id} (${snap.comment})${RESET}`);
    } catch (err) {
      console.log(`${RED}Error: ${err.message}${RESET}`);
    }
  }
}

async function handleRollback(gameId, snapshotId) {
  if (!gameId || !snapshotId) {
    console.log(`${RED}Error: Game ID and Snapshot ID are required.${RESET}`);
    return;
  }

  const running = await isDaemonRunning();
  if (running) {
    try {
      const res = await fetch(`${API_URL}/games/${gameId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId })
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`${GREEN}✔ Successfully rolled back to snapshot: ${snapshotId}!${RESET}`);
      } else {
        console.log(`${RED}Error: ${data.error}${RESET}`);
      }
    } catch (e) {
      console.log(`${RED}Error: ${e.message}${RESET}`);
    }
  } else {
    try {
      restoreSnapshot(gameId, snapshotId);
      console.log(`${GREEN}✔ Successfully rolled back offline to: ${snapshotId}!${RESET}`);
    } catch (err) {
      console.log(`${RED}Error: ${err.message}${RESET}`);
    }
  }
}

async function handleBranch(gameId, branchName) {
  if (!gameId || !branchName) {
    console.log(`${RED}Error: Game ID and Branch name are required.${RESET}`);
    return;
  }

  const running = await isDaemonRunning();
  if (running) {
    try {
      const res = await fetch(`${API_URL}/games/${gameId}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchName })
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`${GREEN}✔ Created branch "${branchName}" for game ID "${gameId}"!${RESET}`);
      } else {
        console.log(`${RED}Error: ${data.error}${RESET}`);
      }
    } catch (e) {
      console.log(`${RED}Error: ${e.message}${RESET}`);
    }
  } else {
    try {
      createBranch(gameId, branchName);
      console.log(`${GREEN}✔ Created branch offline: "${branchName}"!${RESET}`);
    } catch (err) {
      console.log(`${RED}Error: ${err.message}${RESET}`);
    }
  }
}

async function handleCheckout(gameId, branchName) {
  if (!gameId || !branchName) {
    console.log(`${RED}Error: Game ID and Branch name are required.${RESET}`);
    return;
  }

  const running = await isDaemonRunning();
  if (running) {
    try {
      const res = await fetch(`${API_URL}/games/${gameId}/branch/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchName })
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`${GREEN}✔ Switched branch to "${branchName}" for game ID "${gameId}"!${RESET}`);
      } else {
        console.log(`${RED}Error: ${data.error}${RESET}`);
      }
    } catch (e) {
      console.log(`${RED}Error: ${e.message}${RESET}`);
    }
  } else {
    try {
      switchBranch(gameId, branchName);
      console.log(`${GREEN}✔ Switched branch offline to: "${branchName}"!${RESET}`);
    } catch (err) {
      console.log(`${RED}Error: ${err.message}${RESET}`);
    }
  }
}

async function handleDaemon(action, customPort = null) {
  if (!action || (action !== 'start' && action !== 'stop')) {
    console.log(`${RED}Usage: savesync daemon start [--port <port>] | savesync daemon stop${RESET}`);
    return;
  }

  const running = await isDaemonRunning();

  if (action === 'start') {
    if (running) {
      console.log(`${YELLOW}Daemon is already running at port ${PORT}.${RESET}`);
      return;
    }

    const portToUse = customPort ? parseInt(customPort, 10) : PORT;
    const daemonScript = path.join(__dirname, '../src/daemon/index.js');
    
    console.log(`Starting SaveSync background daemon on port ${portToUse}...`);

    // Spawn daemon independently in background
    const logFile = path.join(db.getSettings().dataDir, 'daemon.log');
    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');

    const args = ['--port', portToUse.toString()];
    const child = spawn('node', [daemonScript, ...args], {
      detached: true,
      stdio: ['ignore', out, err]
    });

    // Write PID file
    fs.writeFileSync(PID_FILE, child.pid.toString(), 'utf8');
    child.unref();

    console.log(`${GREEN}✔ Daemon started in background with PID ${child.pid}!${RESET}`);
    console.log(`Logs: ${logFile}`);
    console.log(`UI Web Dashboard: http://localhost:${portToUse}`);
  } else if (action === 'stop') {
    if (!running && !fs.existsSync(PID_FILE)) {
      console.log(`${YELLOW}Daemon is not running.${RESET}`);
      return;
    }

    console.log('Stopping SaveSync daemon...');
    let pid = null;
    
    if (fs.existsSync(PID_FILE)) {
      pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    }

    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`${GREEN}✔ Terminated daemon process (PID ${pid}).${RESET}`);
      } catch (e) {
        console.log(`${YELLOW}Process PID ${pid} could not be killed directly. Attempting port cleanup...${RESET}`);
      }
      try {
        fs.unlinkSync(PID_FILE);
      } catch (e) {}
    } else {
      console.log(`${RED}No PID file found. Please stop the node process manually if it is still running.${RESET}`);
    }
  }
}

async function handleScan() {
  console.log(asciiArt);
  console.log(`${BOLD}Scanning system for installed game & emulator saves...${RESET}\n`);

  let discovered = [];
  const running = await isDaemonRunning();
  
  if (running) {
    try {
      const res = await fetch(`${API_URL}/presets/scan`);
      discovered = await res.json();
    } catch (e) {
      console.log(`${YELLOW}⚠ Failed to scan via daemon. Falling back to offline scanner...${RESET}`);
      discovered = await scanInstalledSaves();
    }
  } else {
    discovered = await scanInstalledSaves();
  }

  if (discovered.length === 0) {
    console.log(`${YELLOW}No installed game save presets or emulators detected automatically.${RESET}`);
    console.log(`You can still track any custom folder manually:`);
    console.log(`  ${CYAN}savesync add "<Game Name>" "<Save Folder Path>"${RESET}`);
    return;
  }

  console.log(`${BOLD}${GREEN}✔ Detected ${discovered.length} save folders on your system:${RESET}`);
  console.log('----------------------------------------------------');
  for (const item of discovered) {
    console.log(`${BOLD}${CYAN}${item.name}${RESET} [Type: ${item.type}]`);
    console.log(`  Path: ${item.savePath}`);
    console.log(`  To track: ${YELLOW}savesync add "${item.name}" "${item.savePath}"${RESET}`);
    console.log('');
  }
}

async function handlePairCode(code) {
  if (!code) {
    console.log(`${RED}Error: Sync room code is required.${RESET}`);
    console.log(`Usage: ${CYAN}savesync pair-code <room-code>${RESET}`);
    return;
  }

  const running = await isDaemonRunning();
  if (running) {
    try {
      const res = await fetch(`${API_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncCode: code })
      });
      if (res.ok) {
        console.log(`${GREEN}✔ Sync code registered successfully! Daemon connected to WAN room: "${code}".${RESET}`);
      } else {
        const err = await res.json();
        console.log(`${RED}Error: ${err.error}${RESET}`);
      }
    } catch (e) {
      console.log(`${RED}Error connecting to daemon: ${e.message}${RESET}`);
    }
  } else {
    try {
      db.updateSettings({ syncCode: code });
      console.log(`${GREEN}✔ Sync code registered offline: "${code}". Connect the daemon to start WAN syncing.${RESET}`);
    } catch (e) {
      console.log(`${RED}Error: ${e.message}${RESET}`);
    }
  }
}

main();
