# Regular App Karafun Bridge

A system tray application that bridges **The Regular App** song queue (Supabase Realtime) with the **Karafun** karaoke software running locally.

---

## What it does

1. Runs silently in the system tray (Windows + Mac)
2. Subscribes to your community's song queue in real time via Supabase
3. When a singer submits a song with `status='submitted'`:
   - **Confirm mode** (default): the song appears in the Queue Manager window for the KJ to approve or skip
   - **Auto mode**: the song is added to Karafun immediately, no confirmation required
4. Communicates with Karafun via its local WebSocket API (`ws://localhost:57921`)
5. Updates the Supabase `song_selections` row to `status='queued'` and stores the Karafun `queueId`

### Tray icon colours

| Colour | Meaning |
|--------|---------|
| Green  | Both Supabase and Karafun connected |
| Yellow | Supabase connected, Karafun not running |
| Red    | Supabase disconnected |

---

## Requirements

- [Karafun](https://www.karafun.com/) desktop app running on the same machine
- Karafun Remote Control feature enabled (Settings → Remote Control)
- Node.js 18+ (development only)

---

## Development

```bash
cd karafun-bridge
npm install
npm start
```

The app will open to the Settings window on first launch (no credentials stored yet).

### Dev tips

- All app data (encrypted config) is stored in Electron's `userData` directory:
  - **Windows**: `%APPDATA%\karafun-bridge\`
  - **Mac**: `~/Library/Application Support/karafun-bridge/`
- To reset settings, delete `bridge-config.enc` from that directory.
- Console output appears in the terminal where you ran `npm start`.

---

## Configuration (first run)

1. Launch the app — the Settings window opens automatically.
2. Paste your **Supabase anon key** (found in your Supabase project → Settings → API → `anon public` key).
3. Click **Load Communities** to populate the dropdown, then select your community.
4. Choose **Confirm** or **Auto-Queue** mode.
5. Click **Save Settings** — the bridge subscribes immediately.

Settings are stored encrypted on disk using Electron's `safeStorage` (OS keychain on Mac, DPAPI on Windows). The anon key is never sent anywhere except to the Supabase API.

---

## Build (producing installers)

### Prerequisites

```bash
npm install
```

### Windows installer (run on Windows)

```bash
npm run build:win
```

Produces: `dist/karafun-bridge-win.exe` (NSIS installer)

### Mac DMG (run on Mac)

```bash
npm run build:mac
```

Produces: `dist/karafun-bridge-mac.dmg`

### Both platforms

```bash
npm run build
```

> **Note:** Cross-compilation is not supported. Build the Windows installer on Windows and the Mac DMG on a Mac.

---

## Distribution

Copy the built installers to the main web app's public downloads directory so KJs can download them from the app:

```bash
# From the karafun-bridge directory after building:
cp dist/karafun-bridge-win.exe ../app/public/downloads/
cp dist/karafun-bridge-mac.dmg ../app/public/downloads/
```

Then link to them from the app UI at:
- `/downloads/karafun-bridge-win.exe`
- `/downloads/karafun-bridge-mac.dmg`

---

## Assets

> **Action required before building:** You must provide real icon files:

| File | Size | Used for |
|------|------|----------|
| `assets/icon.png` | 512×512 | App icon (installer, dock, taskbar) |
| `assets/tray-icon.png` | 16×16 (or 32×32 @2x) | System tray icon |

The tray icon should be a simple, recognisable shape that reads at 16px. A white or light-coloured icon on transparent background works best on both dark and light OS themes.

On Mac, provide a `tray-icon@2x.png` (32×32) alongside `tray-icon.png` (16×16) for Retina displays — Electron picks it up automatically.

---

## Architecture

```
main.js          — Electron main process, tray, IPC handlers, state
karafun.js       — WebSocket client for Karafun Remote Control API
supabase-client.js — Supabase init, realtime subscription, REST updates
preload.js       — contextBridge API exposed to renderer windows
windows/
  settings.html  — First-run / credential config window
  queue.html     — Live queue manager (KJ approval UI)
assets/
  icon.png       — App icon (replace with real asset)
  tray-icon.png  — Tray icon (replace with real asset)
```

---

## Karafun WebSocket API reference

The bridge uses Karafun's Remote Control WebSocket at `ws://localhost:57921`.

```json
// Add a song
{ "id": 1, "method": "addToQueue", "params": { "id": 12345, "singer": "Jane" } }
// Response
{ "id": 1, "result": { "queueId": "abc123" } }

// Get current queue
{ "id": 2, "method": "getQueue", "params": {} }

// Remove from queue
{ "id": 3, "method": "removeFromQueue", "params": { "queueId": "abc123" } }
```

Enable it in Karafun: **Settings → Remote Control → Enable Remote Control**.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tray icon is yellow | Open Karafun and ensure Remote Control is enabled |
| Tray icon is red | Check your anon key and internet connection; open Settings to re-save |
| "No Karafun ID" warning on a song card | The song in your database is missing `karafun_song_id` — it must be linked to a Karafun library song to auto-queue |
| App doesn't appear after double-clicking | Check the system tray (Windows: click the ^ arrow in the taskbar; Mac: menu bar) |
