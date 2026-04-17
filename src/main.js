'use strict';

const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  ipcMain,
  nativeImage,
  safeStorage,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'bridge-config.enc');
const ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '..', 'assets');

// ─── State ────────────────────────────────────────────────────────────────────
let tray = null;
let settingsWin = null;
let queueWin = null;

const state = {
  supabaseConnected: false,
  karafunConnected: false,
  mode: 'confirm',          // 'confirm' | 'auto'
  communityId: null,
  pendingSongs: [],         // songs waiting for manual confirmation
};

// Lazily-required after settings load so we can pass the anon key
let supabase = null;
let karafun = null;

// ─── Config (encrypted) ───────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const encrypted = fs.readFileSync(CONFIG_PATH);
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: treat as plain JSON (dev environments without keychain)
      return JSON.parse(encrypted.toString('utf-8'));
    }
    const decrypted = safeStorage.decryptString(encrypted);
    return JSON.parse(decrypted);
  } catch (err) {
    console.error('Failed to load config:', err);
    return {};
  }
}

function saveConfig(config) {
  try {
    const json = JSON.stringify(config);
    if (!safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(CONFIG_PATH, json, 'utf-8');
      return;
    }
    const encrypted = safeStorage.encryptString(json);
    fs.writeFileSync(CONFIG_PATH, encrypted);
  } catch (err) {
    console.error('Failed to save config:', err);
    throw err;
  }
}

// ─── Tray icon helpers ────────────────────────────────────────────────────────
/**
 * Build a 16×16 colored square as a fallback when PNG assets are missing.
 * color: '#22c55e' green, '#eab308' yellow, '#ef4444' red
 */
function makeColorIcon(hexColor) {
  // 16×16 single-colour PNG via nativeImage from dataURL isn't available,
  // so we construct a minimal 1×1 scaled nativeImage from a Buffer.
  // For production, replace with real PNG assets in assets/.
  const size = 16;
  // Tiny valid 16×16 PNG (all transparent) — will be tinted at runtime.
  // We'll use an empty image and rely on tooltip text instead if assets missing.
  try {
    const iconPath = path.join(ASSETS_DIR, 'tray-icon.png');
    if (fs.existsSync(iconPath)) {
      return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    }
  } catch (_) {}
  return nativeImage.createEmpty();
}

function getTrayIcon() {
  return makeColorIcon(
    state.supabaseConnected && state.karafunConnected
      ? '#22c55e'  // green — both connected
      : !state.supabaseConnected
        ? '#ef4444' // red — Supabase down
        : '#eab308' // yellow — Karafun not running
  );
}

function getTrayTooltip() {
  const kStatus = state.karafunConnected ? 'Karafun: Connected' : 'Karafun: Not Running';
  const sStatus = state.supabaseConnected ? 'Supabase: Connected' : 'Supabase: Disconnected';
  const modeLabel = state.mode === 'auto' ? 'Auto-Queue' : 'Confirm Mode';
  return `Regular App Karafun Bridge\n${sStatus}\n${kStatus}\nMode: ${modeLabel}`;
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(getTrayIcon());
  tray.setToolTip(getTrayTooltip());
  buildTrayMenu();
}

// ─── Tray context menu ────────────────────────────────────────────────────────
function buildTrayMenu() {
  const pendingCount = state.pendingSongs.length;
  const queueLabel = pendingCount > 0
    ? `Open Queue Manager (${pendingCount} pending)`
    : 'Open Queue Manager';

  const menu = Menu.buildFromTemplate([
    {
      label: queueLabel,
      click: openQueueWindow,
    },
    {
      label: 'Settings',
      click: openSettingsWindow,
    },
    {
      label: `Mode: ${state.mode === 'auto' ? 'Auto-Queue' : 'Confirm'}`,
      click: () => {
        state.mode = state.mode === 'auto' ? 'confirm' : 'auto';
        // Persist the mode change
        const config = loadConfig();
        config.mode = state.mode;
        saveConfig(config);
        refreshTray();
        broadcastStatus();
      },
    },
    { type: 'separator' },
    {
      label: `Supabase: ${state.supabaseConnected ? 'Connected' : 'Disconnected'}`,
      enabled: false,
    },
    {
      label: `Karafun: ${state.karafunConnected ? 'Connected' : 'Not Running'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ─── Windows ──────────────────────────────────────────────────────────────────
function createWindow(htmlFile, options = {}) {
  const win = new BrowserWindow({
    width: options.width || 480,
    height: options.height || 600,
    resizable: options.resizable !== false,
    show: false,
    title: options.title || 'Karafun Bridge',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    ...(options.extra || {}),
  });

  win.loadFile(path.join(__dirname, 'windows', htmlFile));
  win.once('ready-to-show', () => win.show());

  // Don't destroy — just hide — so state is preserved
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  return win;
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = createWindow('settings.html', {
    width: 480,
    height: 520,
    resizable: false,
    title: 'Karafun Bridge — Settings',
  });
}

function openQueueWindow() {
  if (queueWin && !queueWin.isDestroyed()) {
    queueWin.show();
    queueWin.focus();
    broadcastSongs();
    return;
  }
  queueWin = createWindow('queue.html', {
    width: 640,
    height: 700,
    title: 'Karafun Bridge — Queue Manager',
  });
}

// ─── IPC broadcasts ───────────────────────────────────────────────────────────
function broadcastSongs() {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send('songs-updated', state.pendingSongs);
    }
  });
}

function broadcastStatus() {
  const status = {
    supabaseConnected: state.supabaseConnected,
    karafunConnected: state.karafunConnected,
    mode: state.mode,
    communityId: state.communityId,
  };
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send('status-updated', status);
    }
  });
}

// ─── Song handling ────────────────────────────────────────────────────────────
async function handleNewSong(row) {
  console.log('New song received:', row.singer_name, '-', row.song_title);

  if (state.mode === 'auto') {
    await queueSong(row);
  } else {
    // Confirm mode: add to pending list
    if (!state.pendingSongs.find((s) => s.id === row.id)) {
      state.pendingSongs.push(row);
      broadcastSongs();
      refreshTray();
      // Open the queue window to alert the KJ
      openQueueWindow();
    }
  }
}

async function queueSong(row) {
  if (!karafun || !karafun.isConnected) {
    console.warn('Cannot queue — Karafun not connected');
    return;
  }
  if (!row.karafun_song_id) {
    console.warn('Song has no karafun_song_id:', row.id);
    return;
  }
  try {
    const queueId = await karafun.addToQueue(row.karafun_song_id, row.singer_name || 'Unknown');
    await supabase.updateSongStatus(row.id, 'queued', queueId);
    console.log('Queued:', row.song_title, '→ queueId:', queueId);
  } catch (err) {
    console.error('Failed to queue song:', err);
  }
}

async function skipSong(songId) {
  const idx = state.pendingSongs.findIndex((s) => s.id === songId);
  if (idx === -1) return;
  const [row] = state.pendingSongs.splice(idx, 1);
  broadcastSongs();
  refreshTray();
  try {
    await supabase.updateSongStatus(row.id, 'skipped', null);
  } catch (err) {
    console.error('Failed to mark song skipped:', err);
  }
}

// ─── Supabase initialisation ──────────────────────────────────────────────────
function initSupabase(anonKey, communityId) {
  supabase = require('./supabase-client');
  supabase.init(anonKey);
  state.communityId = communityId;

  supabase.subscribeToQueue(
    communityId,
    (row) => handleNewSong(row),
    (status) => {
      console.log('Supabase realtime status:', status);
      state.supabaseConnected = status === 'SUBSCRIBED';
      refreshTray();
      broadcastStatus();
    }
  );
}

// ─── Karafun initialisation ───────────────────────────────────────────────────
function initKarafun() {
  karafun = require('./karafun');

  karafun.on('connected', () => {
    console.log('Karafun connected');
    state.karafunConnected = true;
    refreshTray();
    broadcastStatus();
  });

  karafun.on('disconnected', () => {
    console.log('Karafun disconnected — will retry');
    state.karafunConnected = false;
    refreshTray();
    broadcastStatus();
  });

  karafun.on('error', (err) => {
    console.error('Karafun error:', err);
  });

  // connect() resolves on first success; retries internally on failure
  karafun.connect().catch((err) => {
    console.error('Karafun initial connect error:', err);
  });
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-songs', () => state.pendingSongs);

ipcMain.handle('get-status', () => ({
  supabaseConnected: state.supabaseConnected,
  karafunConnected: state.karafunConnected,
  mode: state.mode,
  communityId: state.communityId,
}));

ipcMain.handle('add-song', async (_event, songId) => {
  const row = state.pendingSongs.find((s) => s.id === songId);
  if (!row) return { ok: false, error: 'Song not found in pending list' };

  if (!karafun || !karafun.isConnected) {
    return { ok: false, error: 'Karafun is not connected' };
  }
  if (!row.karafun_song_id) {
    return { ok: false, error: 'This song has no Karafun ID — it cannot be added automatically' };
  }

  try {
    const queueId = await karafun.addToQueue(row.karafun_song_id, row.singer_name || 'Unknown');
    await supabase.updateSongStatus(row.id, 'queued', queueId);

    // Remove from pending
    state.pendingSongs = state.pendingSongs.filter((s) => s.id !== songId);
    broadcastSongs();
    refreshTray();
    return { ok: true, queueId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skip-song', async (_event, songId) => {
  try {
    await skipSong(songId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-settings', () => {
  const config = loadConfig();
  return {
    // Never return the raw anon key to the renderer — just indicate if set
    hasAnonKey: !!config.anonKey,
    communityId: config.communityId || null,
    mode: config.mode || 'confirm',
  };
});

ipcMain.handle('get-communities', async () => {
  if (!supabase) return { ok: false, error: 'Supabase not initialised yet' };
  try {
    const communities = await supabase.getCommunities();
    return { ok: true, communities };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-settings', async (_event, settings) => {
  const { anonKey, communityId, mode } = settings;

  if (!anonKey || !communityId) {
    return { ok: false, error: 'Anon key and community ID are required' };
  }

  try {
    const existing = loadConfig();
    saveConfig({
      ...existing,
      anonKey,
      communityId,
      mode: mode || 'confirm',
    });

    // Re-initialise with new credentials
    if (supabase) supabase.unsubscribe();
    state.mode = mode || 'confirm';
    state.pendingSongs = [];

    initSupabase(anonKey, communityId);
    refreshTray();
    broadcastStatus();
    broadcastSongs();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.on('ready', () => {
  // macOS: hide dock icon — tray only
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  // Create tray
  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Regular App Karafun Bridge');
  tray.on('double-click', openQueueWindow);
  buildTrayMenu();

  // Load persisted config
  const config = loadConfig();
  state.mode = config.mode || 'confirm';

  // Start Karafun WS regardless of Supabase config
  initKarafun();

  // Only start Supabase if credentials are already saved
  if (config.anonKey && config.communityId) {
    try {
      initSupabase(config.anonKey, config.communityId);
    } catch (err) {
      console.error('Failed to init Supabase on startup:', err);
    }
  } else {
    // First run — open settings immediately
    setTimeout(openSettingsWindow, 500);
  }

  refreshTray();
});

app.on('window-all-closed', (e) => {
  // Prevent quit when all windows close — tray app stays alive
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (karafun) karafun.destroy();
  if (supabase) supabase.unsubscribe();
});
