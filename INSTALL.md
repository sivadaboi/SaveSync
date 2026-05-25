# SaveSync Compilation, Packaging, & Server Hosting Guide

SaveSync is a fully decentralized, self-contained game save synchronization engine. This guide explains how to package it as a native desktop application, compile standard installers, and run WAN synchronization without external cloud servers.

---

## 1. Native Desktop App (Electron)
You can run SaveSync inside a borderless native window instead of hosting it on a web browser.

### Run in Dev Mode
Run the following in the project workspace:
```powershell
# Installs Electron dependencies and boots the native GUI window
npm run start:app
```
This spawns the daemon in the background and renders the dashboard directly as a native desktop application. Closing the window automatically kills folders watchers.

---

## 2. Packaging Standalone Installers
To distribute SaveSync to other gamers, you have two options depending on how lightweight you want the application to be:

### Option A: Standard Setup Wizard (Electron Builder — Recommended)
This packages the app into a standard Windows installer setup wizard (e.g. `SaveSync_1.0.0_Setup.exe`) that installs the app to Program Files, adds Windows Firewall allow rules for private/domain networks, adds registry start entries, and places shortcuts on the desktop.

1. **Install `electron-builder` as a development package**:
   ```powershell
   npm install electron-builder --save-dev
   ```
2. **Compile the Installer**:
   ```powershell
   npm run dist:app
   ```
3. **Output**:
   The installer setup wizard is built inside the `dist-app/` directory. Double-clicking it runs a standard installer wizard.

### Option B: Single Portable Executable (PKG)
If you want to compile the CLI and Daemon into a single `.exe` file without the heavy Electron shell (it will boot the daemon and open their browser automatically):

1. **Install `pkg` globally**:
   ```powershell
   npm install -g pkg
   ```
2. **Compile the binary**:
   ```powershell
   pkg . --targets node20-win-x64 --out-path dist
   ```
3. **Output**:
   Creates `dist/savesync.exe`. This bundles the Node.js runtime, backend logic, and frontend HTML/CSS/JS assets inside a single file. Users can just double-click it.

---

## 3. Connectivity Setup

### LAN / Same Wi-Fi

For peer-to-peer sync on the same local network:

1. Install SaveSync on both devices using the setup wizard.
2. Make sure both devices are on a **Private** Windows network profile, not Public.
3. If Windows asks for firewall access, allow SaveSync on Private networks.
4. Open **Connected Devices**. Devices should appear automatically through UDP discovery.
5. If discovery is blocked by the router, use **Connect via IP Address** with the other device's LAN IP and port `8383`.

The installer adds firewall rules for the app, but some antivirus suites or managed networks can still block local inbound traffic.

## 4. Do We Need a Cloud Server? (Self-Hosted WAN Relay)

**No! You do not need to pay for any cloud servers.**

- **On LAN (Local Network)**: SaveSync works 100% serverless. It uses UDP multicast to auto-discover peers on the same Wi-Fi/Ethernet network.
- **On WAN (Across the Internet)**: You can use your **own local computer as the relay server**, but that relay machine must be reachable by both devices.

### How to use your PC as the WAN Server:
1. **Start the relay from the app**:
   In **Internet Sync -> Relay Server**, enable **Host relay on this PC**, keep port `8386`, and click **Apply Hosting** or **Use Local Relay**.
2. **Configure Router Port Forwarding**:
   On your home router, forward port `8386` (TCP) to your PC's local IP address (e.g., `192.168.1.50`). 
   If your router supports UPnP, you can try automatic setup from the project workspace:
   ```powershell
   npm run port:forward
   ```
   To remove the automatic mapping:
   ```powershell
   npm run port:unforward
   ```
3. **Find your Public IP**:
   SaveSync shows the public relay address in **Internet Sync -> Relay Server**. If unavailable, visit [WhatIsMyIP](https://www.whatismyip.com/) to get your public IP (e.g. `203.0.113.88`).
4. **Link both PCs**:
   - On your PC: In SaveSync settings, enable **Host a Local WAN Relay Server**, set the **WAN WebSocket Relay URL** to `ws://localhost:8386`, and generate a Sync Code (e.g., `ss-alaska-99`).
   - On the Alaska PC: In SaveSync settings, set the **WAN WebSocket Relay URL** to your public IP: `ws://203.0.113.88:8386`. Under WAN Sync, enter the room code `ss-alaska-99` and click **Join**.
   
Both devices will connect to the relay server running **on your PC** to establish the P2P connection and sync saves securely, without any third-party cloud costs!
