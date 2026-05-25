// SaveSync Dashboard App Orchestrator - Sidebar Navigation Edition

let ws = null;
let appState = {
  settings: {},
  games: {},
  peers: {},
  discoveredPeers: [],
  pairingRequests: [],
  wanRoom: null
};

// Public SaveSync cloud relay — no setup needed
const CLOUD_RELAY_URL = 'wss://savesync-relay.onrender.com';
let relayHealthTimer = null;
let activeGameId = null;
let discoveredSavesList = [];
let activeConflictData = null;
let pendingRollbackSnapId = null;

// ============================================================
// DOM REFS
// ============================================================
const localDeviceName    = document.getElementById('local-device-name');
const daemonStatusText   = document.getElementById('daemon-status-text');
const titlebarStatus     = document.getElementById('titlebar-status');

const statGamesCount     = document.getElementById('stat-games-count');
const statPeersCount     = document.getElementById('stat-peers-count');
const statBackupsCount   = document.getElementById('stat-backups-count');
const statSyncStatus     = document.getElementById('stat-sync-status');

const gamesGrid          = document.getElementById('games-grid');
const scanResultsGrid    = document.getElementById('scan-results-grid');
const pairedPeersList    = document.getElementById('paired-peers-list');
const discoveredPeersList= document.getElementById('discovered-peers-list');
const pairingRequestsPanel = document.getElementById('pairing-requests-panel');
const pairingRequestsList  = document.getElementById('pairing-requests-list');

const formAddGame        = document.getElementById('form-add-game');
const gameNameInput      = document.getElementById('game-name-input');
const gamePathInput      = document.getElementById('game-path-input');
const formAddPeer        = document.getElementById('form-add-peer');
const peerAddressInput   = document.getElementById('peer-address-input');
const peerPortInput      = document.getElementById('peer-port-input');
const peerProbeStatus    = document.getElementById('peer-probe-status');
const formCreateBranch   = document.getElementById('form-create-branch');
const branchNameInput    = document.getElementById('branch-name-input');
const formSnapshotComment= document.getElementById('form-snapshot-comment');
const snapshotCommentInput = document.getElementById('snapshot-comment-input');

const formWanSync        = document.getElementById('form-wan-sync');
const wanCodeInput       = document.getElementById('wan-code-input');
const activeWanRoomDisplay = document.getElementById('active-wan-room-display');
const wanRoomNameLbl     = document.getElementById('wan-room-name-lbl');
const btnLeaveWanRoom    = document.getElementById('btn-leave-wan-room');
const btnGenerateWanCode = document.getElementById('btn-generate-wan-code');
const wanConnectionState = document.getElementById('wan-connection-state');
const wanRelayUrlLbl     = document.getElementById('wan-relay-url-lbl');
const wanRoomPeersList   = document.getElementById('wan-room-peers-list');
const wanRoomPeerCount   = document.getElementById('wan-room-peer-count');
const wanRelayUrlInput   = document.getElementById('wan-relay-url-input');
const wanHostRelay       = document.getElementById('wan-host-relay');
const wanRelayPortInput  = document.getElementById('wan-relay-port-input');
const wanLocalIps        = document.getElementById('wan-local-ips');
const wanPublicIp        = document.getElementById('wan-public-ip');
const btnSaveWanHosting  = document.getElementById('btn-save-wan-hosting');
const btnUseLocalRelay   = document.getElementById('btn-use-local-relay');

const formUpdateSettings = document.getElementById('form-update-settings');
const settingsDeviceName = document.getElementById('settings-device-name');
const settingsStartOnBoot = document.getElementById('settings-start-on-boot');
const settingsSpeedLimit = document.getElementById('settings-speed-limit');
const settingsRelayUrl   = document.getElementById('settings-relay-url');
const settingsHostRelay  = document.getElementById('settings-host-relay');
const settingsRelayPort  = document.getElementById('settings-relay-port');
const relayPortConfigContainer  = document.getElementById('relay-port-config-container');
const relayIpsConfigContainer   = document.getElementById('relay-ips-config-container');
const settingsLocalIps   = document.getElementById('settings-local-ips');
const settingsPublicIp   = document.getElementById('settings-public-ip');

const btnBrowseFolder    = document.getElementById('btn-browse-folder');
const btnRunScan         = document.getElementById('btn-run-scan');
const btnRunScanInner    = document.getElementById('btn-run-scan-inner');
const btnTrackAll        = document.getElementById('btn-track-all');
const btnUntrackAll      = document.getElementById('btn-untrack-all');

const addGameModal       = document.getElementById('add-game-modal');
const btnAddGameModal    = document.getElementById('btn-add-game-modal');
const btnEmptyAddGame    = document.getElementById('btn-empty-add-game');
const createBranchModal  = document.getElementById('create-branch-modal');
const rollbackConfirmModal = document.getElementById('rollback-confirm-modal');
const snapshotCommentModal = document.getElementById('snapshot-comment-modal');

const gameDetailsDrawer  = document.getElementById('game-details-drawer');
const btnCloseDrawer     = document.getElementById('btn-close-drawer');
const drawerGameName     = document.getElementById('drawer-game-name');
const drawerGamePath     = document.getElementById('drawer-game-path');
const branchSelect       = document.getElementById('branch-select');
const btnCreateBranch    = document.getElementById('btn-create-branch');
const btnDrawerLaunch    = document.getElementById('btn-drawer-launch');
const btnDrawerSync      = document.getElementById('btn-drawer-sync');
const btnDrawerSnapshot  = document.getElementById('btn-drawer-snapshot');
const timelineTree       = document.getElementById('timeline-tree');
const btnDeleteGame      = document.getElementById('btn-delete-game');
const infoBranchName     = document.getElementById('info-branch-name');
const infoSnapshotCount  = document.getElementById('info-snapshot-count');
const infoLastBackup     = document.getElementById('info-last-backup');

const drawerCoverImg     = document.getElementById('drawer-cover-img');
const drawerCoverPlaceholder = document.getElementById('drawer-cover-placeholder');
const formGameLaunchSettings = document.getElementById('form-game-launch-settings');
const drawerGameAppid    = document.getElementById('drawer-game-appid');
const drawerGameExepath  = document.getElementById('drawer-game-exepath');
const btnBrowseGameExe   = document.getElementById('btn-browse-game-exe');
const drawerGameCoverurl = document.getElementById('drawer-game-coverurl');

// ============================================================
// INIT
// ============================================================
function initApp() {
  connectWebSocket();
  setupEventListeners();
  setupNavigation();
  restoreSavedBackupDir();
}

// ============================================================
// SIDEBAR NAVIGATION
// ============================================================
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item[data-view]');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const viewId = item.getAttribute('data-view');
      navigateTo(viewId);
    });
  });
}

function navigateTo(viewId) {
  // Deactivate all nav items and views
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

  // Activate the clicked nav item and the matching view
  const navItem = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  const view = document.getElementById(`view-${viewId}`);
  if (navItem) navItem.classList.add('active');
  if (view) view.classList.add('active');

  // Side effects on navigation
  if (viewId === 'settings') {
    settingsDeviceName.value = appState.settings.deviceName || '';
    const settingsDeviceType = document.getElementById('settings-device-type');
    if (settingsDeviceType) settingsDeviceType.value = appState.settings.deviceType || 'desktop';
    if (settingsStartOnBoot) settingsStartOnBoot.checked = !!appState.settings.startOnBoot;
    if (settingsSpeedLimit) settingsSpeedLimit.value = appState.settings.speedLimit || '0';
    settingsRelayUrl.value = appState.settings.relayUrl || 'ws://localhost:8386';
    settingsHostRelay.checked = !!appState.settings.hostRelay;
    settingsRelayPort.value = appState.settings.relayPort || 8386;
    syncWanControls();
    toggleRelayContainers(settingsHostRelay.checked);
    loadRelayIps();
  }
  if (viewId === 'wan') {
    syncWanControls();
    loadRelayIps();
    // Start relay health polling for the WAN view
    loadRelayHealth();
    if (relayHealthTimer) clearInterval(relayHealthTimer);
    relayHealthTimer = setInterval(loadRelayHealth, 15000);
  } else {
    // Stop polling when leaving WAN view
    if (relayHealthTimer) { clearInterval(relayHealthTimer); relayHealthTimer = null; }
  }
}

// ============================================================
// WEBSOCKET
// ============================================================
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  showToast('Connecting to SaveSync daemon...', 'info');

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    titlebarStatus.classList.remove('offline');
    daemonStatusText.textContent = 'Daemon Online';
    showToast('Daemon connected! Real-time syncing active.', 'success');
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  };

  ws.onclose = () => {
    titlebarStatus.classList.add('offline');
    daemonStatusText.textContent = 'Daemon Offline';
    showToast('Daemon connection lost. Reconnecting...', 'error');
    setTimeout(connectWebSocket, 3000);
  };
}

function handleWebSocketMessage(message) {
  const { event, data } = message;
  switch (event) {
    case 'init':
      appState = data;
      renderAll();
      checkActiveConflicts(data.activeConflicts);
      initConsole(data.logHistory);
      break;
    case 'console-log':
      appendLogLine(data);
      break;
    case 'games-update':
      appState.games = data;
      renderGames();
      updateStats();
      if (activeGameId) renderDrawerDetails();
      if (discoveredSavesList.length > 0) renderScanResults(discoveredSavesList);
      break;
    case 'peers-update':
      appState.peers = data.paired;
      appState.discoveredPeers = data.discovered;
      appState.pairingRequests = data.requests;
      appState.wanRoom = data.wanRoom || appState.wanRoom;
      renderPeers();
      renderWanRoom();
      updateStats();
      updateConsoleDevices();
      break;
    case 'sync-start':
      statSyncStatus.textContent = 'Syncing...';
      statSyncStatus.className = 'stat-pill-val text-warning';
      showToast(data.message || 'Syncing saves...', 'info');
      updateConsoleDevices();
      break;
    case 'sync-complete':
      statSyncStatus.textContent = 'Idle';
      statSyncStatus.className = 'stat-pill-val text-success';
      let conflictPeer = null;
      if (data.result && data.result.peersSynced) {
        conflictPeer = data.result.peersSynced.find(p => p.status === 'conflict');
      }
      if (conflictPeer) {
        showToast(`Sync conflict detected for ${getGameName(data.gameId)}!`, 'warning');
        openConflictModal(data.gameId, conflictPeer.peerId, conflictPeer.peerName, conflictPeer.localSnap, conflictPeer.remoteSnap);
      } else {
        showToast('Sync complete!', 'success');
      }
      updateConsoleDevices();
      break;
    case 'sync-error':
      statSyncStatus.textContent = 'Error';
      statSyncStatus.className = 'stat-pill-val text-danger';
      showToast(`Sync failed: ${data.error}`, 'error');
      updateConsoleDevices();
      break;
  }
}

function getGameName(gameId) {
  return appState.games[gameId]?.name || gameId;
}

// ============================================================
// EVENT LISTENERS
// ============================================================
function setupEventListeners() {
  // Custom Titlebar Window Controls
  document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
    fetch('/api/window/minimize', { method: 'POST' }).catch(() => {});
  });
  document.getElementById('titlebar-maximize')?.addEventListener('click', () => {
    fetch('/api/window/maximize', { method: 'POST' }).catch(() => {});
  });
  document.getElementById('titlebar-close')?.addEventListener('click', () => {
    fetch('/api/window/close', { method: 'POST' }).catch(() => {});
  });

  // Add Game Modal
  btnAddGameModal.addEventListener('click', () => openModal(addGameModal));
  btnEmptyAddGame?.addEventListener('click', () => openModal(addGameModal));
  btnCreateBranch.addEventListener('click', () => openModal(createBranchModal));

  // Close Modals
  document.querySelectorAll('.btn-close-modal').forEach(btn => {
    btn.addEventListener('click', () => closeModal(addGameModal));
  });
  document.querySelectorAll('.btn-close-submodal').forEach(btn => {
    btn.addEventListener('click', () => {
      closeModal(createBranchModal);
      closeModal(rollbackConfirmModal);
      closeModal(snapshotCommentModal);
    });
  });

  // Browse Folder (Add Game)
  btnBrowseFolder.addEventListener('click', async () => {
    btnBrowseFolder.disabled = true;
    const orig = btnBrowseFolder.textContent;
    btnBrowseFolder.textContent = '...';
    try {
      const res = await fetch('/api/browse-directory');
      if (res.ok) {
        const data = await res.json();
        if (data.path) gamePathInput.value = data.path;
      } else {
        const err = await res.json();
        showToast(err.error || 'Browse folder only available in the desktop app.', 'warning');
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      btnBrowseFolder.disabled = false;
      btnBrowseFolder.textContent = orig;
    }
  });

  // Add Game Submit
  formAddGame.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = gameNameInput.value.trim();
    const savePath = gamePathInput.value.trim();
    await trackFolder(name, savePath);
    formAddGame.reset();
    closeModal(addGameModal);
  });

  // Settings Submit
  formUpdateSettings.addEventListener('submit', async (e) => {
    e.preventDefault();
    const deviceName = settingsDeviceName.value.trim();
    const deviceType = document.getElementById('settings-device-type')?.value || 'desktop';
    const startOnBoot = settingsStartOnBoot ? settingsStartOnBoot.checked : false;
    const speedLimit  = settingsSpeedLimit ? parseInt(settingsSpeedLimit.value, 10) : 0;
    const relayUrl   = settingsRelayUrl.value.trim();
    const hostRelay  = settingsHostRelay.checked;
    const relayPort  = parseInt(settingsRelayPort.value, 10) || 8386;
    await saveSettings({
      deviceName,
      deviceType,
      relayUrl,
      syncCode: appState.settings.syncCode,
      hostRelay,
      relayPort,
      startOnBoot,
      speedLimit
    });
    await loadRelayIps();
  });

  // Host Relay Toggle
  settingsHostRelay.addEventListener('change', () => toggleRelayContainers(settingsHostRelay.checked));

  // Scanner
  btnRunScan.addEventListener('click', runDirectoryScan);
  btnRunScanInner?.addEventListener('click', runDirectoryScan);

  // Track All
  btnTrackAll.addEventListener('click', async () => {
    const untracked = discoveredSavesList.filter(item =>
      !Object.values(appState.games).some(g => g.savePath.toLowerCase() === item.savePath.toLowerCase())
    );
    if (untracked.length === 0) return;
    btnTrackAll.disabled = true;
    btnTrackAll.textContent = 'Tracking...';
    showToast(`Tracking ${untracked.length} save folders...`, 'info');
    let count = 0;
    for (const item of untracked) {
      const success = await trackFolder(item.name, item.savePath);
      if (success) count++;
    }
    showToast(`Tracked ${count} / ${untracked.length} folders!`, 'success');
    btnTrackAll.disabled = false;
    btnTrackAll.textContent = '➕ Track All';
    runDirectoryScan();
  });

  // Untrack All
  btnUntrackAll.addEventListener('click', async () => {
    const tracked = discoveredSavesList.filter(item =>
      Object.values(appState.games).some(g => g.savePath.toLowerCase() === item.savePath.toLowerCase())
    );
    if (tracked.length === 0) return;
    if (!confirm(`Stop tracking all ${tracked.length} autodetected save folders?`)) return;
    btnUntrackAll.disabled = true;
    btnUntrackAll.textContent = 'Untracking...';
    let count = 0;
    for (const item of tracked) {
      const matchedGame = Object.values(appState.games).find(g => g.savePath.toLowerCase() === item.savePath.toLowerCase());
      if (matchedGame) {
        try {
          const res = await fetch(`/api/games/${matchedGame.id}`, { method: 'DELETE' });
          if (res.ok) count++;
        } catch (e) {}
      }
    }
    showToast(`Untracked ${count} folders.`, 'info');
    btnUntrackAll.disabled = false;
    btnUntrackAll.textContent = '❌ Untrack All';
    runDirectoryScan();
  });

  // WAN Sync
  formWanSync.addEventListener('submit', async (e) => {
    e.preventDefault();
    await updateSyncCode(wanCodeInput.value.trim());
  });
  btnLeaveWanRoom.addEventListener('click', async () => await updateSyncCode(''));
  btnGenerateWanCode.addEventListener('click', () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let code = 'ss-';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    wanCodeInput.value = code;
    updateSyncCode(code);
  });
  btnSaveWanHosting?.addEventListener('click', async () => {
    await saveSettings({
      relayUrl: wanRelayUrlInput?.value.trim() || appState.settings.relayUrl,
      hostRelay: !!wanHostRelay?.checked,
      relayPort: parseInt(wanRelayPortInput?.value, 10) || 8386
    }, 'WAN relay settings saved.');
    await loadRelayIps();
  });
  btnUseLocalRelay?.addEventListener('click', async () => {
    const port = parseInt(wanRelayPortInput?.value, 10) || 8386;
    if (wanRelayUrlInput) wanRelayUrlInput.value = `ws://localhost:${port}`;
    if (wanHostRelay) wanHostRelay.checked = true;
    await saveSettings({
      relayUrl: `ws://localhost:${port}`,
      hostRelay: true,
      relayPort: port
    }, 'Local relay enabled.');
    await loadRelayIps();
  });

  // "Use Cloud Relay" button — sets relay URL to the public SaveSync relay
  document.getElementById('btn-use-cloud-relay')?.addEventListener('click', async () => {
    if (wanRelayUrlInput) wanRelayUrlInput.value = CLOUD_RELAY_URL;
    if (wanHostRelay) wanHostRelay.checked = false;
    await saveSettings({
      relayUrl: CLOUD_RELAY_URL,
      hostRelay: false
    }, '☁️ Switched to SaveSync cloud relay!');
    loadRelayHealth();
  });

  // Manual Add Peer
  formAddPeer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const address = peerAddressInput.value.trim();
    const port    = parseInt(peerPortInput.value.trim(), 10);
    try {
      const probe = await probePeerAddress(address, port);
      if (!probe) return;

      showToast(`Sending pairing request to ${probe.deviceName} at ${address}:${port}...`, 'info');
      const res = await fetch('/api/peers/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, port })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Pairing: ${data.message || 'Request sent!'}`, 'success');
      } else {
        showToast(data.error, 'error');
      }
    } catch (err) {
      showToast(`Pairing failed: ${err.message}`, 'error');
    }
  });

  const probeOnInput = debounce(async () => {
    const address = peerAddressInput.value.trim();
    const port = parseInt(peerPortInput.value.trim(), 10);
    if (!address || !port) {
      setPeerProbeStatus('', '');
      return;
    }
    await probePeerAddress(address, port, { quiet: true });
  }, 700);

  peerAddressInput.addEventListener('input', probeOnInput);
  peerPortInput.addEventListener('input', probeOnInput);

  // Drawer
  btnCloseDrawer.addEventListener('click', closeDrawer);
  branchSelect.addEventListener('change', async (e) => {
    const branchName = e.target.value;
    const res = await fetch(`/api/games/${activeGameId}/branch/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchName })
    });
    if (res.ok) showToast(`Switched to branch: ${branchName}`, 'success');
    else { const err = await res.json(); showToast(err.error, 'error'); }
  });

  formCreateBranch.addEventListener('submit', async (e) => {
    e.preventDefault();
    const branchName = branchNameInput.value.trim();
    const res = await fetch(`/api/games/${activeGameId}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchName })
    });
    if (res.ok) {
      showToast(`Branch "${branchName}" created!`, 'success');
      formCreateBranch.reset();
      closeModal(createBranchModal);
    } else {
      const err = await res.json(); showToast(err.error, 'error');
    }
  });

  btnDrawerSnapshot.addEventListener('click', () => openModal(snapshotCommentModal));
  formSnapshotComment.addEventListener('submit', async (e) => {
    e.preventDefault();
    const comment = snapshotCommentInput.value.trim();
    const res = await fetch(`/api/games/${activeGameId}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment })
    });
    if (res.ok) {
      showToast('Snapshot saved!', 'success');
      formSnapshotComment.reset();
      closeModal(snapshotCommentModal);
    } else {
      const err = await res.json(); showToast(err.error, 'error');
    }
  });

  btnDrawerSync.addEventListener('click', async () => {
    const res = await fetch(`/api/games/${activeGameId}/sync`, { method: 'POST' });
    if (!res.ok) { const err = await res.json(); showToast(`Sync failed: ${err.error}`, 'error'); }
  });

  document.getElementById('btn-confirm-rollback-execute').addEventListener('click', async () => {
    if (!activeGameId || !pendingRollbackSnapId) return;
    const res = await fetch(`/api/games/${activeGameId}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: pendingRollbackSnapId })
    });
    if (res.ok) {
      showToast(`Rolled back to: ${pendingRollbackSnapId}`, 'success');
      closeModal(rollbackConfirmModal);
      pendingRollbackSnapId = null;
    } else {
      const err = await res.json(); showToast(err.error, 'error');
    }
  });

  btnDeleteGame.addEventListener('click', async () => {
    if (!confirm('Stop tracking this folder? Snapshots will not be deleted.')) return;
    const res = await fetch(`/api/games/${activeGameId}`, { method: 'DELETE' });
    if (res.ok) { showToast('Game untracked.', 'info'); closeDrawer(); }
    else { const err = await res.json(); showToast(err.error, 'error'); }
  });

  // Browse Executable (Game Launch Settings)
  btnBrowseGameExe?.addEventListener('click', async () => {
    btnBrowseGameExe.disabled = true;
    const orig = btnBrowseGameExe.textContent;
    btnBrowseGameExe.textContent = '...';
    try {
      const res = await fetch('/api/browse-file');
      if (res.ok) {
        const data = await res.json();
        if (data.path) drawerGameExepath.value = data.path;
      } else {
        const err = await res.json();
        showToast(err.error || 'Browse file only available in the desktop app.', 'warning');
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      btnBrowseGameExe.disabled = false;
      btnBrowseGameExe.textContent = orig;
    }
  });

  // Save Game Launch Config
  formGameLaunchSettings?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeGameId) return;

    const appId = drawerGameAppid.value.trim();
    const exePath = drawerGameExepath.value.trim();
    const coverUrl = drawerGameCoverurl.value.trim();

    try {
      const res = await fetch(`/api/games/${activeGameId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, exePath, coverUrl })
      });
      if (res.ok) {
        showToast('Launch configuration updated!', 'success');
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to save configuration', 'error');
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });

  // Launch Game Action
  btnDrawerLaunch?.addEventListener('click', async () => {
    if (!activeGameId) return;
    btnDrawerLaunch.disabled = true;
    const origText = btnDrawerLaunch.textContent;
    btnDrawerLaunch.textContent = 'Launching...';
    try {
      const res = await fetch(`/api/games/${activeGameId}/launch`, { method: 'POST' });
      if (res.ok) {
        showToast('Game launch requested.', 'success');
      } else {
        const err = await res.json();
        showToast(err.error || 'Launch failed', 'error');
      }
    } catch (err) {
      showToast('Launch error: ' + err.message, 'error');
    } finally {
      btnDrawerLaunch.disabled = false;
      btnDrawerLaunch.textContent = origText;
    }
  });

  // Conflict Resolution
  document.getElementById('btn-conflict-keep-local')?.addEventListener('click', () => resolveActiveConflict('keep-local'));
  document.getElementById('btn-conflict-keep-remote')?.addEventListener('click', () => resolveActiveConflict('keep-remote'));
  document.getElementById('btn-conflict-keep-both')?.addEventListener('click', () => resolveActiveConflict('merge-branch'));
  document.getElementById('btn-close-conflict-modal')?.addEventListener('click', () => {
    document.getElementById('conflict-modal').classList.add('hidden');
    activeConflictData = null;
  });

  // ---- BACKUP EXPORT ----
  const btnBrowseBackupDir = document.getElementById('btn-browse-backup-dir');
  const inputBackupDir     = document.getElementById('settings-backup-dir');
  const btnExecuteBackup   = document.getElementById('btn-execute-backup');
  const backupResultsContainer = document.getElementById('backup-results-container');
  const lblBackupFolder    = document.getElementById('lbl-backup-folder');
  const lblBackupRatio     = document.getElementById('lbl-backup-ratio');
  const lblBackupOrig      = document.getElementById('lbl-backup-orig');
  const lblBackupComp      = document.getElementById('lbl-backup-comp');

  btnBrowseBackupDir?.addEventListener('click', () => browseDirectory(inputBackupDir, 'savesync_last_backup_dir'));

  btnExecuteBackup?.addEventListener('click', async () => {
    const exportDir = inputBackupDir?.value.trim();
    if (!exportDir) { showToast('Please specify a destination directory first.', 'warning'); return; }
    btnExecuteBackup.disabled = true;
    const origText = btnExecuteBackup.textContent;
    btnExecuteBackup.textContent = '📦 Compressing...';
    backupResultsContainer?.classList.add('hidden');
    try {
      showToast('Starting Brotli backup...', 'info');
      const res = await fetch('/api/backup/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exportDir })
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('savesync_last_backup_dir', exportDir);
        if (lblBackupFolder) lblBackupFolder.textContent = data.backupFolder;
        if (lblBackupRatio)  lblBackupRatio.textContent  = data.savings;
        if (lblBackupOrig)   lblBackupOrig.textContent   = (data.totalOriginal / 1024).toFixed(1) + ' KB';
        if (lblBackupComp)   lblBackupComp.textContent   = (data.totalCompressed / 1024).toFixed(1) + ' KB';
        backupResultsContainer?.classList.remove('hidden');
        showToast('Backup created successfully!', 'success');
      } else {
        const err = await res.json();
        showToast(err.error || 'Backup failed', 'error');
      }
    } catch (err) {
      showToast('Backup error: ' + err.message, 'error');
    } finally {
      btnExecuteBackup.disabled = false;
      btnExecuteBackup.textContent = origText;
    }
  });

  // ---- BACKUP RESTORE ----
  const btnBrowseRestoreDir    = document.getElementById('btn-browse-restore-dir');
  const inputRestoreDir        = document.getElementById('restore-backup-dir');
  const btnExecuteRestore      = document.getElementById('btn-execute-restore');
  const restoreResultsContainer= document.getElementById('restore-results-container');
  const restoreResultTitle     = document.getElementById('restore-result-title');
  const restoreResultDetails   = document.getElementById('restore-result-details');

  btnBrowseRestoreDir?.addEventListener('click', () => browseDirectory(inputRestoreDir, 'savesync_last_restore_dir'));

  btnExecuteRestore?.addEventListener('click', async () => {
    const backupPath = inputRestoreDir?.value.trim();
    if (!backupPath) { showToast('Please select a backup folder first.', 'warning'); return; }

    btnExecuteRestore.disabled = true;
    const origText = btnExecuteRestore.textContent;
    btnExecuteRestore.textContent = '🔄 Restoring...';
    restoreResultsContainer?.classList.add('hidden');

    try {
      showToast('Restoring saves from backup...', 'info');
      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backupPath })
      });

      if (res.ok) {
        const data = await res.json();
        if (restoreResultTitle) {
          restoreResultTitle.textContent = `✓ Restore Complete: ${data.restored} restored, ${data.skipped} skipped, ${data.errors} errors`;
        }
        if (restoreResultDetails) {
          restoreResultDetails.innerHTML = '';
          data.details.forEach(d => {
            const icon = d.status === 'restored' ? '✅' : d.status === 'skipped' ? '⏭️' : '❌';
            const div = document.createElement('div');
            div.className = 'restore-detail-item';
            div.innerHTML = `<span>${icon}</span><strong>${d.name}</strong><span style="color:var(--text-3)">${d.reason || d.path || ''}</span>`;
            restoreResultDetails.appendChild(div);
          });
        }
        restoreResultsContainer?.classList.remove('hidden');
        showToast(`Restore complete! ${data.restored} game(s) restored.`, 'success');
      } else {
        const err = await res.json();
        showToast(err.error || 'Restore failed', 'error');
      }
    } catch (err) {
      showToast('Restore error: ' + err.message, 'error');
    } finally {
      btnExecuteRestore.disabled = false;
      btnExecuteRestore.textContent = origText;
    }
  });
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function setPeerProbeStatus(message, type = 'info') {
  if (!peerProbeStatus) return;
  if (!message) {
    peerProbeStatus.classList.add('hidden');
    peerProbeStatus.textContent = '';
    return;
  }
  peerProbeStatus.classList.remove('hidden');
  peerProbeStatus.textContent = message;
  peerProbeStatus.style.borderColor = type === 'success' ? 'rgba(16,185,129,0.35)' : type === 'error' ? 'rgba(239,68,68,0.35)' : '';
  peerProbeStatus.style.color = type === 'success' ? 'var(--emerald)' : type === 'error' ? 'var(--red)' : '';
}

async function probePeerAddress(address, port, { quiet = false } = {}) {
  try {
    setPeerProbeStatus(`Checking ${address}:${port}...`, 'info');
    const res = await fetch('/api/peers/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, port })
    });
    const data = await res.json();
    if (!res.ok || !data.reachable) {
      const message = data.error || `Could not reach SaveSync at ${address}:${port}.`;
      setPeerProbeStatus(message, 'error');
      if (!quiet) showToast(message, 'error');
      return null;
    }

    setPeerProbeStatus(`Found ${data.deviceName} (${data.deviceType}) at ${address}:${port}.`, 'success');
    return data;
  } catch (err) {
    const message = `Could not check ${address}:${port}: ${err.message}`;
    setPeerProbeStatus(message, 'error');
    if (!quiet) showToast(message, 'error');
    return null;
  }
}

// ============================================================
// HELPERS
// ============================================================
async function browseDirectory(inputEl, storageKey) {
  const btn = document.activeElement;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/browse-directory');
    if (res.ok) {
      const data = await res.json();
      if (data.path) {
        inputEl.value = data.path;
        if (storageKey) localStorage.setItem(storageKey, data.path);
      }
    } else {
      const err = await res.json();
      showToast(err.error || 'Browse only available in the desktop app.', 'warning');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function restoreSavedBackupDir() {
  const backupInput = document.getElementById('settings-backup-dir');
  const restoreInput = document.getElementById('restore-backup-dir');
  const savedBackup = localStorage.getItem('savesync_last_backup_dir');
  const savedRestore = localStorage.getItem('savesync_last_restore_dir');
  if (backupInput && savedBackup) backupInput.value = savedBackup;
  if (restoreInput && savedRestore) restoreInput.value = savedRestore;
}

async function trackFolder(name, savePath) {
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, savePath })
    });
    if (res.ok) { showToast(`Started monitoring: ${name}`, 'success'); return true; }
    else { const err = await res.json(); showToast(err.error, 'error'); return false; }
  } catch (err) { showToast(`Failed: ${err.message}`, 'error'); return false; }
}

function syncWanControls() {
  if (wanRelayUrlInput) wanRelayUrlInput.value = appState.settings.relayUrl || 'ws://localhost:8386';
  if (wanHostRelay) wanHostRelay.checked = !!appState.settings.hostRelay;
  if (wanRelayPortInput) wanRelayPortInput.value = appState.settings.relayPort || 8386;
}

async function saveSettings(fields, successMessage = 'Settings saved!') {
  try {
    const payload = {
      deviceName: appState.settings.deviceName,
      deviceType: appState.settings.deviceType || 'desktop',
      relayUrl: appState.settings.relayUrl || 'ws://localhost:8386',
      syncCode: appState.settings.syncCode || '',
      hostRelay: !!appState.settings.hostRelay,
      relayPort: appState.settings.relayPort || 8386,
      startOnBoot: !!appState.settings.startOnBoot,
      speedLimit: appState.settings.speedLimit || 0,
      ...fields
    };
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || 'Failed to save settings.', 'error');
      return null;
    }
    appState.settings = data;
    if (settingsRelayUrl) settingsRelayUrl.value = data.relayUrl || 'ws://localhost:8386';
    if (settingsHostRelay) settingsHostRelay.checked = !!data.hostRelay;
    if (settingsRelayPort) settingsRelayPort.value = data.relayPort || 8386;
    syncWanControls();
    showToast(successMessage, 'success');
    renderAll();
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    return null;
  }
}

async function updateSyncCode(syncCode) {
  try {
    const relayUrl = wanRelayUrlInput?.value.trim() || appState.settings.relayUrl;
    if (relayUrl && relayUrl !== appState.settings.relayUrl) {
      await saveSettings({ relayUrl }, 'Relay URL saved.');
    }
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: appState.settings.deviceName, relayUrl, syncCode })
    });
    if (res.ok) {
      showToast(syncCode ? `Joined WAN Room: "${syncCode}"` : 'Left WAN room.', syncCode ? 'success' : 'info');
    } else {
      const err = await res.json(); showToast(err.error, 'error');
    }
  } catch (err) { showToast(`Failed: ${err.message}`, 'error'); }
}

async function runDirectoryScan() {
  btnRunScan.disabled = true;
  btnRunScan.textContent = '🔎 Scanning...';
  if (btnRunScanInner) { btnRunScanInner.disabled = true; btnRunScanInner.textContent = 'Scanning...'; }
  showToast('Scanning for emulator & repack saves...', 'info');
  try {
    const res = await fetch('/api/presets/scan');
    if (!res.ok) throw new Error(`Scan returned code ${res.status}`);
    const discovered = await res.json();
    discoveredSavesList = discovered;
    renderScanResults(discovered);
    showToast(`Scan complete! ${discovered.length} save folders found.`, 'success');
  } catch (err) {
    showToast(`Scan failed: ${err.message}`, 'error');
  } finally {
    btnRunScan.disabled = false;
    btnRunScan.textContent = '🔎 Scan System';
    if (btnRunScanInner) { btnRunScanInner.disabled = false; btnRunScanInner.textContent = 'Scan Saves'; }
  }
}

function toggleRelayContainers(isHosting) {
  relayPortConfigContainer?.classList.toggle('hidden', !isHosting);
  relayIpsConfigContainer?.classList.toggle('hidden', !isHosting);
}

async function loadRelayIps() {
  if (settingsLocalIps) settingsLocalIps.textContent = 'Loading...';
  if (settingsPublicIp) settingsPublicIp.textContent = 'Loading...';
  if (wanLocalIps) wanLocalIps.textContent = 'Loading...';
  if (wanPublicIp) wanPublicIp.textContent = 'Loading...';
  try {
    const res = await fetch('/api/relay/ips');
    if (res.ok) {
      const data = await res.json();
      const port = appState.settings.relayPort || parseInt(wanRelayPortInput?.value, 10) || 8386;
      const lanUrls = (data.localIps || []).map(ip => `ws://${ip}:${port}`).join(', ') || 'None';
      const publicUrl = data.publicIp && !data.publicIp.startsWith('Could not') ? `ws://${data.publicIp}:${port}` : 'Unavailable';
      if (settingsLocalIps) settingsLocalIps.textContent = data.localIps?.join(', ') || 'None';
      if (settingsPublicIp) settingsPublicIp.textContent = data.publicIp || 'Unavailable';
      if (wanLocalIps) wanLocalIps.textContent = lanUrls;
      if (wanPublicIp) wanPublicIp.textContent = publicUrl;
    }
  } catch (_) {
    if (settingsLocalIps) settingsLocalIps.textContent = 'Failed';
    if (settingsPublicIp) settingsPublicIp.textContent = 'Failed';
    if (wanLocalIps) wanLocalIps.textContent = 'Failed';
    if (wanPublicIp) wanPublicIp.textContent = 'Failed';
  }
}

// ============================================================
// CLOUD RELAY HEALTH
// ============================================================
async function loadRelayHealth() {
  const dot   = document.getElementById('relay-health-dot');
  const label = document.getElementById('relay-health-label');
  const meta  = document.getElementById('relay-health-meta');
  const btn   = document.getElementById('btn-use-cloud-relay');
  if (!dot || !label) return;

  // Indicate checking
  dot.className     = 'relay-health-dot checking';
  label.textContent = 'Checking relay…';
  if (meta) meta.textContent = '';

  // Show/hide the cloud relay button depending on current URL
  const currentUrl = appState.settings.relayUrl || '';
  const isCloud    = currentUrl === CLOUD_RELAY_URL;
  if (btn) btn.style.display = isCloud ? 'none' : '';

  try {
    const t0  = Date.now();
    const res = await fetch('/api/relay/health', { signal: AbortSignal.timeout(7000) });
    const ms  = Date.now() - t0;
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.reachable) {
      dot.className     = 'relay-health-dot online';
      label.textContent = isCloud ? '☁️ Cloud relay online' : 'Relay online';
      if (meta) meta.textContent = `${ms}ms · ${data.clients ?? 0} clients · ${data.rooms ?? 0} rooms`;
    } else {
      dot.className     = 'relay-health-dot offline';
      label.textContent = isCloud ? '☁️ Cloud relay unreachable' : 'Relay unreachable';
      if (meta) meta.textContent = data.error ? data.error.slice(0, 60) : '';
    }
  } catch (err) {
    dot.className     = 'relay-health-dot offline';
    label.textContent = 'Relay check failed';
    if (meta) meta.textContent = err.message.slice(0, 60);
  }
}

// ============================================================
// RENDERING
// ============================================================
function renderAll() {
  // Device name
  if (localDeviceName) localDeviceName.textContent = appState.settings.deviceName || 'Local PC';
  syncWanControls();

  // WAN room
  const syncCode = appState.settings.syncCode;
  if (syncCode) {
    formWanSync?.classList.add('hidden');
    activeWanRoomDisplay?.classList.remove('hidden');
    if (wanRoomNameLbl) wanRoomNameLbl.textContent = syncCode;
    if (wanCodeInput) wanCodeInput.value = syncCode;
  } else {
    formWanSync?.classList.remove('hidden');
    activeWanRoomDisplay?.classList.add('hidden');
    if (wanRoomNameLbl) wanRoomNameLbl.textContent = 'None';
    if (wanCodeInput) wanCodeInput.value = '';
  }

  renderWanRoom();
  renderGames();
  renderPeers();
  updateStats();
  if (activeGameId) renderDrawerDetails();
  updateConsoleDevices();
}

function renderGames() {
  const gamesList = Object.values(appState.games);
  const navBadge = document.getElementById('nav-badge-games');
  if (navBadge) navBadge.textContent = gamesList.length;

  if (gamesList.length === 0) {
    gamesGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎮</div>
        <h3>No save folders tracked yet</h3>
        <p>Track a custom directory or run the scanner below to discover emulators &amp; repack saves automatically.</p>
        <button id="btn-empty-add-game-inner" class="btn-primary">Track a Game</button>
      </div>
    `;
    document.getElementById('btn-empty-add-game-inner')?.addEventListener('click', () => openModal(addGameModal));
    return;
  }

  gamesGrid.innerHTML = '';
  gamesList.forEach(game => {
    const card = document.createElement('article');
    card.className = 'game-card';

    const branch   = game.branches[game.activeBranch];
    const snapCount = branch ? branch.snapshots.length : 0;

    // Determine cover URL
    let coverSrc = '';
    if (game.coverUrl) {
      coverSrc = game.coverUrl;
    } else if (game.appId) {
      coverSrc = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${game.appId}/library_600x900.jpg`;
    }

    const coverHtml = coverSrc 
      ? `<div class="game-card-cover" style="background-image: url('${coverSrc}');"></div>`
      : `<div class="game-card-cover">🎮</div>`;

    card.innerHTML = `
      ${coverHtml}
      <div class="game-card-body">
        <div class="game-card-header">
          <h3 class="game-title" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;" title="${game.name}">${game.name}</h3>
          <span class="game-branch-badge">${game.activeBranch}</span>
        </div>
        <p class="game-path-text" style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; height: 28px;" title="${game.savePath}">${game.savePath}</p>
        <div class="game-footer-info" style="margin-top: 0; padding-top: 6px;">
          <span class="backup-count-info">Backups: <strong>${snapCount}</strong></span>
          <span class="sync-badge synced">
            <span class="pulse-indicator" style="background:var(--emerald); box-shadow:0 0 6px var(--emerald);"></span> Synced
          </span>
        </div>
      </div>
    `;
    card.addEventListener('click', () => openDrawer(game.id));
    gamesGrid.appendChild(card);
  });
}

function renderScanResults(discovered) {
  if (discovered.length === 0) {
    btnTrackAll.classList.add('hidden');
    btnUntrackAll.classList.add('hidden');
    scanResultsGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔎</div>
        <h3>No emulator or repack saves found</h3>
        <p>Ensure emulators (Dolphin, RPCS3, Ryujinx, etc.) have active saves, or track a custom folder.</p>
        <button id="btn-run-scan-inner-2" class="btn-primary">Scan Again</button>
      </div>
    `;
    document.getElementById('btn-run-scan-inner-2')?.addEventListener('click', runDirectoryScan);
    return;
  }

  const untrackedCount = discovered.filter(item =>
    !Object.values(appState.games).some(g => g.savePath.toLowerCase() === item.savePath.toLowerCase())
  ).length;
  const trackedCount = discovered.filter(item =>
    Object.values(appState.games).some(g => g.savePath.toLowerCase() === item.savePath.toLowerCase())
  ).length;

  if (untrackedCount > 0) { btnTrackAll.classList.remove('hidden'); btnTrackAll.textContent = `➕ Track All (${untrackedCount})`; }
  else { btnTrackAll.classList.add('hidden'); }
  if (trackedCount > 0) { btnUntrackAll.classList.remove('hidden'); btnUntrackAll.textContent = `❌ Untrack All (${trackedCount})`; }
  else { btnUntrackAll.classList.add('hidden'); }

  scanResultsGrid.innerHTML = '';
  discovered.forEach(item => {
    const isTracked = Object.values(appState.games).some(g => g.savePath.toLowerCase() === item.savePath.toLowerCase());
    const card = document.createElement('article');
    card.className = 'game-card';
    if (item.type === 'emulator') card.style.borderColor = 'rgba(6,182,212,0.3)';
    else if (item.type === 'repack') card.style.borderColor = 'rgba(249,115,22,0.3)';

    // Determine cover URL for the scanner card
    let coverSrc = '';
    if (item.appId) {
      coverSrc = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${item.appId}/library_600x900.jpg`;
    }

    const coverHtml = coverSrc 
      ? `<div class="game-card-cover" style="background-image: url('${coverSrc}');"></div>`
      : `<div class="game-card-cover">🎮</div>`;

    card.innerHTML = `
      ${coverHtml}
      <div class="game-card-body">
        <div class="game-card-header">
          <h3 class="game-title" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;" title="${item.name}">${item.name}</h3>
          <span class="game-branch-badge" style="background:rgba(255,255,255,0.05);color:var(--text-3);border:none;">${item.type.toUpperCase()}</span>
        </div>
        <p class="game-path-text" style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; height: 28px;" title="${item.savePath}">${item.savePath}</p>
        <div class="game-footer-info" style="margin-top: 0; padding-top: 6px; align-items:center;">
          <span class="backup-count-info" style="font-size:11px;">Status: <strong>${isTracked ? 'Monitored' : 'Not Monitored'}</strong></span>
          ${isTracked
            ? `<span style="color:var(--emerald);font-weight:600;font-size:11px;">✓ Active</span>`
            : `<button class="btn-peer-action" onclick="trackDiscoveredSave('${item.name.replace(/'/g, "\\'")}', '${item.savePath.replace(/\\/g, '\\\\')}')">+ Track</button>`
          }
        </div>
      </div>
    `;
    scanResultsGrid.appendChild(card);
  });
}

function renderPeers() {
  const paired   = Object.values(appState.peers || {});
  const discovered = appState.discoveredPeers || [];
  const requests = appState.pairingRequests || [];

  const navBadge = document.getElementById('nav-badge-peers');
  if (navBadge) navBadge.textContent = paired.filter(p => p.status === 'online').length;

  // Paired
  if (paired.length === 0) {
    pairedPeersList.innerHTML = `<li class="empty-list-msg">No devices paired. Add a peer via IP/port or approve a LAN discovery request.</li>`;
  } else {
    pairedPeersList.innerHTML = '';
    paired.forEach(peer => {
      const li = document.createElement('li');
      const isWan = peer.address === 'relay';
      li.innerHTML = `
        <div class="peer-info">
          <span class="peer-name-txt">
            <span class="peer-status-dot ${peer.status}"></span>
            ${peer.name} ${isWan ? '<span class="badge-pill" style="font-size:8px;padding:1px 5px;">WAN</span>' : ''}
          </span>
          <span class="peer-ip-txt">${isWan ? 'Connected via Relay' : `${peer.address}:${peer.port}`}</span>
        </div>
        <button class="btn-secondary btn-sm" onclick="removePeer('${peer.id}')">Unpair</button>
      `;
      pairedPeersList.appendChild(li);
    });
  }

  // Discovered
  const unpairedDiscovered = discovered.filter(p => !paired.some(pp => pp.id === p.id));
  if (unpairedDiscovered.length === 0) {
    discoveredPeersList.innerHTML = `<li class="empty-list-msg">Scanning network...</li>`;
  } else {
    discoveredPeersList.innerHTML = '';
    unpairedDiscovered.forEach(peer => {
      const isWan = peer.address === 'relay' || peer.isWan;
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="peer-info">
          <span class="peer-name-txt">${isWan ? '🌐' : '📡'} ${peer.deviceName}</span>
          <span class="peer-ip-txt">${isWan ? 'Discovered via WAN Room' : `${peer.address}:${peer.port}`}</span>
        </div>
        <button class="btn-primary btn-sm" onclick="sendOutboundPairing('${peer.address}', ${peer.port}, ${isWan}, '${peer.id || ''}')">Pair</button>
      `;
      discoveredPeersList.appendChild(li);
    });
  }

  // Pairing requests
  if (requests.length === 0) {
    pairingRequestsPanel?.classList.add('hidden');
  } else {
    pairingRequestsPanel?.classList.remove('hidden');
    pairingRequestsList.innerHTML = '';
    requests.forEach(req => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="peer-info">
          <span class="peer-name-txt">⚠️ ${req.deviceName}</span>
          <span class="peer-ip-txt">${req.address === 'relay' ? 'Pairing via WAN' : `${req.address}:${req.port}`} wants to pair</span>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-accent btn-sm" onclick="approvePairing('${req.peerId}')">✓ Approve</button>
          <button class="btn-danger btn-sm" onclick="rejectPairing('${req.peerId}')">&times;</button>
        </div>
      `;
      pairingRequestsList.appendChild(li);
    });
  }
}

function renderWanRoom() {
  const wanRoom = appState.wanRoom || {
    enabled: !!appState.settings.syncCode,
    connected: false,
    state: appState.settings.syncCode ? 'connecting' : 'disconnected',
    relayUrl: appState.settings.relayUrl,
    roomCode: appState.settings.syncCode,
    peers: []
  };

  const peers = wanRoom.peers || (appState.discoveredPeers || []).filter(p => p.address === 'relay' || p.isWan);
  const paired = appState.peers || {};
  const onlinePeers = peers.filter(peer => peer.online !== false);

  if (wanRelayUrlLbl) {
    wanRelayUrlLbl.textContent = wanRoom.relayUrl || appState.settings.relayUrl || 'Not configured';
  }
  if (wanRoomPeerCount) {
    wanRoomPeerCount.textContent = `${onlinePeers.length} ONLINE`;
  }
  if (wanConnectionState) {
    const state = wanRoom.connected ? 'CONNECTED' : (wanRoom.state || 'DISCONNECTED').toUpperCase();
    wanConnectionState.textContent = state;
    wanConnectionState.classList.toggle('badge-warning', !wanRoom.connected);
    wanConnectionState.style.background = wanRoom.connected ? 'rgba(16,185,129,0.12)' : '';
    wanConnectionState.style.color = wanRoom.connected ? 'var(--emerald)' : '';
    wanConnectionState.style.borderColor = wanRoom.connected ? 'rgba(16,185,129,0.28)' : '';
  }

  if (!wanRoomPeersList) return;

  if (!wanRoom.enabled) {
    wanRoomPeersList.innerHTML = `<li class="empty-list-msg">Join a room to see relay peers.</li>`;
    return;
  }

  if (wanRoom.error && !wanRoom.connected) {
    wanRoomPeersList.innerHTML = `<li class="empty-list-msg">Relay error: ${wanRoom.error}</li>`;
    return;
  }

  if (peers.length === 0) {
    wanRoomPeersList.innerHTML = `<li class="empty-list-msg">Waiting for other devices in this room...</li>`;
    return;
  }

  wanRoomPeersList.innerHTML = '';
  peers.forEach(peer => {
    const isPaired = !!paired[peer.id] || peer.paired;
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="peer-info">
        <span class="peer-name-txt">
          <span class="peer-status-dot ${peer.online === false ? 'offline' : 'online'}"></span>
          ${peer.deviceName || 'Unknown Device'}
        </span>
        <span class="peer-ip-txt">${peer.deviceType || 'desktop'} - ${isPaired ? 'Paired' : 'Ready to pair'}</span>
      </div>
      ${isPaired
        ? `<span style="color:var(--emerald);font-weight:600;font-size:11px;">Paired</span>`
        : `<button class="btn-primary btn-sm" onclick="sendOutboundPairing('relay', ${peer.port || 0}, true, '${peer.id}')">Pair</button>`
      }
    `;
    wanRoomPeersList.appendChild(li);
  });
}

function updateStats() {
  const gamesList  = Object.values(appState.games);
  const pairedPeers = Object.values(appState.peers || {});
  if (statGamesCount) statGamesCount.textContent = gamesList.length;
  if (statPeersCount) statPeersCount.textContent = pairedPeers.filter(p => p.status === 'online').length;

  let totalBackups = 0;
  gamesList.forEach(g => {
    for (const b in g.branches) totalBackups += g.branches[b].snapshots?.length || 0;
  });
  if (statBackupsCount) statBackupsCount.textContent = totalBackups;
}

// ============================================================
// DRAWER
// ============================================================
function openDrawer(gameId) {
  activeGameId = gameId;
  gameDetailsDrawer.classList.remove('hidden');
  renderDrawerDetails();
}

function closeDrawer() {
  activeGameId = null;
  gameDetailsDrawer.classList.add('hidden');
}

function renderDrawerDetails() {
  const game = appState.games[activeGameId];
  if (!game) { closeDrawer(); return; }

  drawerGameName.textContent = game.name;
  drawerGamePath.textContent = game.savePath;

  // Populate launch configuration form fields
  if (drawerGameAppid) drawerGameAppid.value = game.appId || '';
  if (drawerGameExepath) drawerGameExepath.value = game.exePath || '';
  if (drawerGameCoverurl) drawerGameCoverurl.value = game.coverUrl || '';

  // Show or hide launch button based on launch config state
  if (btnDrawerLaunch) {
    if (game.appId || game.exePath) {
      btnDrawerLaunch.classList.remove('hidden');
    } else {
      btnDrawerLaunch.classList.add('hidden');
    }
  }

  // Handle drawer vertical cover art rendering
  if (drawerCoverImg && drawerCoverPlaceholder) {
    let coverSrc = '';
    if (game.coverUrl) {
      coverSrc = game.coverUrl;
    } else if (game.appId) {
      coverSrc = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${game.appId}/library_600x900.jpg`;
    }

    if (coverSrc) {
      drawerCoverImg.src = coverSrc;
      drawerCoverImg.classList.remove('hidden');
      drawerCoverPlaceholder.classList.add('hidden');
    } else {
      drawerCoverImg.src = '';
      drawerCoverImg.classList.add('hidden');
      drawerCoverPlaceholder.classList.remove('hidden');
    }
  }

  branchSelect.innerHTML = '';
  Object.keys(game.branches).forEach(bName => {
    const opt = document.createElement('option');
    opt.value = bName;
    opt.textContent = bName;
    if (bName === game.activeBranch) opt.selected = true;
    branchSelect.appendChild(opt);
  });

  const branch = game.branches[game.activeBranch];
  infoBranchName.textContent = game.activeBranch;
  const snapshots = branch ? branch.snapshots : [];
  infoSnapshotCount.textContent = snapshots.length;

  if (snapshots.length > 0) {
    infoLastBackup.textContent = new Date(snapshots[snapshots.length - 1].timestamp).toLocaleString();
  } else {
    infoLastBackup.textContent = 'Never';
  }

  if (snapshots.length === 0) {
    timelineTree.innerHTML = `<div class="empty-list-msg" style="padding-left:0;">No backups on this branch yet. Make changes or click "Save Snapshot".</div>`;
    return;
  }

  timelineTree.innerHTML = '';
  [...snapshots].reverse().forEach(snap => {
    const node = document.createElement('div');
    let nodeClass = '';
    if (snap.isSystemAuto) {
      nodeClass = snap.comment.includes('Pre-rollback') ? 'safety-point' : 'system-auto';
    }
    node.className = `timeline-node ${nodeClass}`;
    node.innerHTML = `
      <div class="node-dot"></div>
      <div class="node-card">
        <div class="node-meta">
          <span class="node-comment">${snap.comment}</span>
          <div class="node-details">
            <span>📅 ${new Date(snap.timestamp).toLocaleString()}</span>
            <span>💾 ${(snap.sizeBytes / 1024).toFixed(1)} KB</span>
            <span>ID: <code class="node-id-badge">${snap.id}</code></span>
          </div>
        </div>
        <button class="btn-rollback-action" onclick="triggerRollbackConfirmation('${snap.id}')">Rollback</button>
      </div>
    `;
    timelineTree.appendChild(node);
  });
}

// ============================================================
// GLOBAL WINDOW ACTIONS
// ============================================================
window.trackDiscoveredSave = async (name, savePath) => {
  const success = await trackFolder(name, savePath);
  if (success) runDirectoryScan();
};

window.triggerRollbackConfirmation = (snapshotId) => {
  pendingRollbackSnapId = snapshotId;
  document.getElementById('rollback-target-id').textContent = snapshotId;
  openModal(rollbackConfirmModal);
};

window.sendOutboundPairing = async (address, port, isWan = false, targetPeerId = null) => {
  try {
    showToast(`Sending pairing request to ${isWan ? 'WAN Peer' : `${address}:${port}`}...`, 'info');
    const res = await fetch('/api/peers/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, port, isWan, targetPeerId })
    });
    const data = await res.json();
    if (res.ok) showToast(`Pairing: ${data.message || 'Sent!'}`, 'success');
    else showToast(data.error, 'error');
  } catch (err) { showToast(err.message, 'error'); }
};

window.approvePairing = async (peerId) => {
  const res = await fetch('/api/peers/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId })
  });
  if (res.ok) showToast('Peer approved.', 'success');
};

window.rejectPairing = async (peerId) => {
  const res = await fetch('/api/peers/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId })
  });
  if (res.ok) showToast('Pairing rejected.', 'info');
};

window.removePeer = async (peerId) => {
  if (!confirm('Unpair from this device? Syncing will stop.')) return;
  const res = await fetch(`/api/peers/${peerId}`, { method: 'DELETE' });
  if (res.ok) showToast('Device unpaired.', 'info');
};

// ============================================================
// MODALS
// ============================================================
function openModal(modal) { modal.classList.remove('hidden'); }
function closeModal(modal) { modal.classList.add('hidden'); }

// ============================================================
// TOAST SYSTEM
// ============================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `
    <span>${icons[type] || 'ℹ️'} ${message}</span>
    <button class="toast-close">&times;</button>
  `;
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================================
// CONFLICT RESOLUTION
// ============================================================
function checkActiveConflicts(activeConflicts) {
  if (!activeConflicts) return;
  for (const gameId in activeConflicts) {
    const conflict = activeConflicts[gameId];
    if (conflict && conflict.peer) {
      openConflictModal(gameId, conflict.peer.id, conflict.peer.name, conflict.localSnap, conflict.remoteSnap);
      break;
    }
  }
}

function openConflictModal(gameId, peerId, peerName, localSnap, remoteSnap) {
  activeConflictData = { gameId, peerId, peerName };
  const modal = document.getElementById('conflict-modal');
  if (!modal) return;
  document.getElementById('conflict-game-name').textContent = getGameName(gameId);
  document.getElementById('conflict-peer-name').textContent = peerName;
  document.getElementById('conflict-local-comment').textContent  = localSnap?.comment  || 'No local snapshots';
  document.getElementById('conflict-local-time').textContent     = localSnap ? new Date(localSnap.timestamp).toLocaleString() : 'Never';
  document.getElementById('conflict-local-id').textContent       = localSnap?.id || 'N/A';
  document.getElementById('conflict-remote-comment').textContent = remoteSnap?.comment || 'No remote snapshots';
  document.getElementById('conflict-remote-time').textContent    = remoteSnap ? new Date(remoteSnap.timestamp).toLocaleString() : 'Never';
  document.getElementById('conflict-remote-id').textContent      = remoteSnap?.id || 'N/A';
  modal.classList.remove('hidden');
}

async function resolveActiveConflict(resolution) {
  if (!activeConflictData) return;
  const { gameId, peerId } = activeConflictData;
  const btns = ['btn-conflict-keep-local','btn-conflict-keep-remote','btn-conflict-keep-both']
    .map(id => document.getElementById(id));
  btns.forEach(b => b && (b.disabled = true));
  try {
    showToast('Resolving conflict...', 'info');
    const res = await fetch(`/api/games/${gameId}/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId, resolution })
    });
    if (res.ok) {
      const data = await res.json();
      showToast(
        resolution === 'merge-branch'
          ? `Conflict resolved! Remote saves in branch: ${data.branchName}`
          : `Conflict resolved using ${resolution === 'keep-local' ? 'local' : 'remote'} saves!`,
        'success'
      );
      document.getElementById('conflict-modal').classList.add('hidden');
      activeConflictData = null;
    } else {
      const err = await res.json(); showToast(`Failed: ${err.error}`, 'error');
    }
  } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
  finally { btns.forEach(b => b && (b.disabled = false)); }
}

// ============================================================
// CONSOLE / LOGS ENGINE
// ============================================================
function initConsole(history = []) {
  const consoleArea = document.getElementById('console-logs-area');
  if (!consoleArea) return;
  
  consoleArea.innerHTML = '';
  
  if (history && history.length > 0) {
    history.forEach(record => {
      appendLogLine(record, false);
    });
    consoleArea.scrollTop = consoleArea.scrollHeight;
  } else {
    appendLogLine({
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'info',
      message: 'SaveSync Console Connection Initialized',
      meta: 'v1.0.0'
    }, false);
  }

  // Bind clear console button
  const btnClear = document.getElementById('btn-clear-console');
  if (btnClear) {
    btnClear.onclick = () => {
      consoleArea.innerHTML = '';
      appendLogLine({
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        type: 'info',
        message: 'Console cleared',
        meta: ''
      });
    };
  }

  updateConsoleDevices();
}

function appendLogLine(record, scroll = true) {
  const consoleArea = document.getElementById('console-logs-area');
  if (!consoleArea) return;

  const line = document.createElement('div');
  line.className = `log-line ${record.type || 'info'}`;

  // Timestamp
  const ts = document.createElement('span');
  ts.className = 'log-timestamp';
  ts.textContent = record.timestamp;
  line.appendChild(ts);

  // Status indicator dot
  const dot = document.createElement('span');
  dot.className = `log-dot ${record.type || 'info'}`;
  line.appendChild(dot);

  // Message
  const msg = document.createElement('span');
  msg.className = 'log-message';
  msg.textContent = record.message;
  line.appendChild(msg);

  // Meta if exists
  if (record.meta) {
    const meta = document.createElement('span');
    meta.className = 'log-meta';
    meta.textContent = record.meta;
    line.appendChild(meta);
  }

  consoleArea.appendChild(line);

  // Keep logs list to max 300 elements
  while (consoleArea.childElementCount > 300) {
    consoleArea.removeChild(consoleArea.firstChild);
  }

  if (scroll) {
    consoleArea.scrollTop = consoleArea.scrollHeight;
  }
}

function updateConsoleDevices() {
  const localType = appState.settings.deviceType || 'desktop';
  
  // Clear active classes from all device cards
  document.querySelectorAll('.device-card').forEach(card => {
    card.classList.remove('active', 'is-local');
  });

  // Mark local device
  const localCard = document.getElementById(`dev-${localType}`);
  if (localCard) {
    localCard.classList.add('active', 'is-local');
  }

  // Check online paired peers and activate their corresponding categories
  const pairedPeersList = Object.values(appState.peers || {});
  pairedPeersList.forEach(peer => {
    if (peer.status === 'online') {
      const type = peer.deviceType || 'desktop';
      const card = document.getElementById(`dev-${type}`);
      if (card) {
        card.classList.add('active');
      }
    }
  });

  // Update console sync status label
  const consoleSyncLabel = document.getElementById('console-sync-status');
  if (consoleSyncLabel) {
    const statusText = document.getElementById('stat-sync-status')?.textContent || 'Idle';
    if (statusText === 'Syncing...') {
      consoleSyncLabel.textContent = '● Syncing delta saves...';
      consoleSyncLabel.style.color = 'var(--orange)';
    } else if (statusText === 'Error') {
      consoleSyncLabel.textContent = '● Connection error';
      consoleSyncLabel.style.color = 'var(--red)';
    } else {
      consoleSyncLabel.textContent = '● All devices synchronized';
      consoleSyncLabel.style.color = 'var(--emerald)';
    }
  }
}

// ============================================================
// BOOT
// ============================================================
window.addEventListener('DOMContentLoaded', initApp);
