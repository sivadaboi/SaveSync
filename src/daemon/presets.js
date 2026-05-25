import fs from 'fs';
import path from 'path';
import os from 'os';

// Substitute Windows environment variables in paths
export function resolvePath(winPath) {
  let resolved = winPath.replace(/\\/g, '/');
  
  // Resolve standard environment variables
  resolved = resolved.replace(/%APPDATA%/gi, process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'));
  resolved = resolved.replace(/%USERPROFILE%/gi, os.homedir());
  resolved = resolved.replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'));
  resolved = resolved.replace(/%PROGRAMDATA%/gi, process.env.PROGRAMDATA || 'C:/ProgramData');
  resolved = resolved.replace(/%PUBLIC%/gi, process.env.PUBLIC || 'C:/Users/Public');
  
  return path.resolve(resolved);
}

// Preset definitions for Emulators, Steam wrappers, and popular games
const PRESETS = [
  // 1. Famous Emulators
  { id: 'ryujinx', name: 'Ryujinx Switch Emulator', type: 'emulator', path: '%APPDATA%/Ryujinx/bis/user/save' },
  { id: 'yuzu', name: 'Yuzu Switch Emulator', type: 'emulator', path: '%APPDATA%/yuzu/nand/user/save' },
  { id: 'citra', name: 'Citra 3DS Emulator', type: 'emulator', path: '%APPDATA%/Citra/sdmc/Nintendo 3DS' },
  { id: 'dolphin', name: 'Dolphin GameCube/Wii Emulator', type: 'emulator', path: '%USERPROFILE%/Documents/Dolphin Emulator' },
  { id: 'pcsx2', name: 'PCSX2 PS2 Emulator', type: 'emulator', path: '%USERPROFILE%/Documents/PCSX2/memcards' },
  { id: 'rpcs3', name: 'RPCS3 PS3 Emulator', type: 'emulator', path: '%APPDATA%/rpcs3/dev_hdd0/home/00000001/savedata' },
  { id: 'cemu', name: 'Cemu Wii U Emulator', type: 'emulator', path: '%USERPROFILE%/Documents/Cemu/mlc01/usr/save' },
  { id: 'ppsspp', name: 'PPSSPP PSP Emulator', type: 'emulator', path: '%USERPROFILE%/Documents/PPSSPP/PSP/SAVEDATA' },
  { id: 'xenia', name: 'Xenia Xbox 360 Emulator', type: 'emulator', path: '%USERPROFILE%/Documents/Xenia/content' },
  { id: 'retroarch-states', name: 'RetroArch Save States', type: 'emulator', path: '%APPDATA%/RetroArch/states' },
  { id: 'retroarch-saves', name: 'RetroArch Save Files', type: 'emulator', path: '%APPDATA%/RetroArch/saves' },

  // 2. Pirated/Repack Game Steam Emulators
  { id: 'goldberg', name: 'Goldberg Steam Emulator', type: 'repack', path: '%APPDATA%/Goldberg SteamEmu Saves', isWrapper: true },
  { id: 'codex', name: 'CODEX / PLAZA Steam Emulator', type: 'repack', path: '%PUBLIC%/Documents/Steam/CODEX', isWrapper: true },
  { id: 'rune', name: 'RUNE Steam Emulator', type: 'repack', path: '%PUBLIC%/Documents/Steam/RUNE', isWrapper: true },
  { id: 'tenoke', name: 'Tenoke Steam Emulator', type: 'repack', path: '%USERPROFILE%/Documents/Steam/TENOKE', isWrapper: true },
  { id: 'flt', name: 'Fairlight (FLT) Saves', type: 'repack', path: '%APPDATA%/FLT', isWrapper: true },
  { id: 'ali', name: 'ALi Saves', type: 'repack', path: '%APPDATA%/ALi', isWrapper: true },
  { id: 'reloaded', name: 'RELOADED (RLD!) Wrapper', type: 'repack', path: '%PROGRAMDATA%/Steam/RLD!', isWrapper: true },
  { id: 'generic-wrapper', name: 'Public Documents Steam Wrapper', type: 'repack', path: '%PUBLIC%/Documents/Steam', isWrapper: true }
];

// Offline fallback dictionary for most popular Steam AppIDs to resolve names instantly offline
const POPULAR_STEAM_GAMES = {
  '480': 'Spacewar (Steam Overlay Wrapper)',
  '730': 'Counter-Strike 2',
  '570': 'Dota 2',
  '550': 'Left 4 Dead 2',
  '400': 'Portal',
  '620': 'Portal 2',
  '105600': 'Terraria',
  '292030': 'The Witcher 3: Wild Hunt',
  '271590': 'Grand Theft Auto V',
  '1091500': 'Cyberpunk 2077',
  '1174180': 'Red Dead Redemption 2',
  '1245620': 'Elden Ring',
  '377160': 'Fallout 4',
  '413150': 'Stardew Valley',
  '814380': 'Sekiro: Shadows Die Twice',
  '1151640': 'Horizon Zero Dawn',
  '218620': 'Payday 2',
  '252490': 'Rust',
  '381210': 'Dead by Daylight',
  '578080': 'PUBG: BATTLEGROUNDS',
  '108600': 'Project Zomboid',
  '230410': 'Warframe',
  '311210': 'Call of Duty: Black Ops III',
  '1145360': 'Hades',
  '1145350': 'Hades II',
  '268910': 'Cuphead',
  '219740': "Don't Starve",
  '322330': "Don't Starve Together",
  '250900': 'The Binding of Isaac: Rebirth',
  '1817070': "Marvel's Spider-Man Remastered",
  '1817190': "Marvel's Spider-Man: Miles Morales",
  '1551360': 'Forza Horizon 5',
  '236390': 'War Thunder',
  '2050650': 'Resident Evil 4',
  '1190460': 'Death Stranding',
  '289070': "Sid Meier's Civilization VI",
  '646570': 'Slay the Spire',
  '4000': "Garry's Mod",
  '2280': 'Doom',
  '379720': 'DOOM (2016)',
  '782330': 'DOOM Eternal'
};

// Simple cache file path for Steam AppID names to avoid repeating queries
const APP_CACHE_FILE = path.join(os.homedir(), '.savesync', 'steam-app-cache.json');

function loadAppCache() {
  try {
    if (fs.existsSync(APP_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(APP_CACHE_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveAppCache(cache) {
  try {
    const homeDir = path.dirname(APP_CACHE_FILE);
    if (!fs.existsSync(homeDir)) {
      fs.mkdirSync(homeDir, { recursive: true });
    }
    fs.writeFileSync(APP_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {}
}

/**
 * Scans the filesystem for matching presets and returns list of discovered save directories.
 * Resolves Steam AppID folder codes to actual game titles in parallel.
 */
export async function scanInstalledSaves() {
  const discovered = [];
  const cache = loadAppCache();

  for (const preset of PRESETS) {
    try {
      const resolved = resolvePath(preset.path);
      if (fs.existsSync(resolved)) {
        // If it's a generic steam wrapper, scan subfolders (each folder is an AppID or Game)
        if (preset.isWrapper) {
          const files = fs.readdirSync(resolved);
          for (const file of files) {
            const fullSubPath = path.join(resolved, file);
            const stat = fs.statSync(fullSubPath);
            if (stat.isDirectory()) {
              // Ignore common Steam wrapper configuration and system folders
              if (['settings', 'remote', 'saves', 'stats', 'storage'].includes(file.toLowerCase())) {
                continue;
              }

              const isAppId = /^\d+$/.test(file);
              discovered.push({
                id: `${preset.id}-${file}`,
                name: `${preset.name} - Game ID: ${file}`,
                type: preset.type,
                savePath: fullSubPath,
                appId: isAppId ? file : null
              });
            }
          }
        } else {
          discovered.push({
            id: preset.id,
            name: preset.name,
            type: preset.type,
            savePath: resolved
          });
        }
      }
    } catch (e) {
      // Ignore scan errors for this preset
    }
  }

  // Add Steam userdata folders
  const steamPath = 'C:/Program Files (x86)/Steam/userdata';
  if (fs.existsSync(steamPath)) {
    try {
      const users = fs.readdirSync(steamPath);
      for (const user of users) {
        const userPath = path.join(steamPath, user);
        if (fs.statSync(userPath).isDirectory()) {
          const games = fs.readdirSync(userPath);
          for (const game of games) {
            const gamePath = path.join(userPath, game);
            if (fs.statSync(gamePath).isDirectory()) {
              const isAppId = /^\d+$/.test(game);
              discovered.push({
                id: `steam-${user}-${game}`,
                name: `Steam User ${user} - AppID: ${game}`,
                type: 'game',
                savePath: gamePath,
                appId: isAppId ? game : null
              });
            }
          }
        }
      }
    } catch (e) {}
  }

  // Resolve AppIDs to real game names in parallel
  const pendingResolutions = discovered.map(async (item) => {
    if (item.appId) {
      // 1. Check local offline fallback dictionary
      if (POPULAR_STEAM_GAMES[item.appId]) {
        item.name = POPULAR_STEAM_GAMES[item.appId];
        return;
      }

      // 2. Check local disk cache
      const cachedName = cache[item.appId];
      if (cachedName) {
        item.name = cachedName;
      } else {
        // 3. Query Steam Store API with custom User-Agent to avoid blocking
        try {
          const url = `https://store.steampowered.com/api/appdetails?appids=${item.appId}&filters=basic`;
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            signal: AbortSignal.timeout(3000)
          });
          if (res.ok) {
            const data = await res.json();
            if (data[item.appId] && data[item.appId].success) {
              const gameName = data[item.appId].data.name;
              item.name = gameName;
              cache[item.appId] = gameName;
            }
          }
        } catch (err) {
          // Keep default Game ID name if resolution fails
        }
      }
    }
  });

  await Promise.allSettled(pendingResolutions);
  saveAppCache(cache);

  return discovered;
}
