'use strict';

/**
 * karafun-db.js
 *
 * Replaces the WebSocket approach. KaraFun exposes no local socket API —
 * instead it stores its queue in a SQLite database at:
 *   %APPDATA%\KaraFun\user_database.db
 *
 * We INSERT directly into the queue_item table using the same schema
 * KaraFun itself uses. KaraFun picks up the change on its next read cycle.
 *
 * Interface matches the old karafun.js (EventEmitter, isConnected,
 * connect(), addToQueue(), destroy()) so main.js needs minimal changes.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto'); // Node 14.17+ built-in

// ── Paths ─────────────────────────────────────────────────────────────────────
const APPDATA   = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DB_PATH   = path.join(APPDATA, 'KaraFun', 'user_database.db');
const LOCK_PATH = path.join(APPDATA, 'KaraFun', 'lockfile'); // exists while KaraFun is running

const POLL_MS = 3000; // check KaraFun running status every 3s

// ── KarafunDB ─────────────────────────────────────────────────────────────────
class KarafunDB extends EventEmitter {
  constructor() {
    super();
    this._pollTimer   = null;
    this._wasRunning  = false;
    this._destroyed   = false;
  }

  /** True when the KaraFun lock file exists (app is open). */
  get isConnected() {
    try {
      return fs.existsSync(DB_PATH) && fs.existsSync(LOCK_PATH);
    } catch {
      return false;
    }
  }

  /**
   * Start polling for KaraFun's running state.
   * Emits 'connected' / 'disconnected' as it changes.
   */
  connect() {
    this._tick();
    return Promise.resolve();
  }

  _tick() {
    if (this._destroyed) return;
    const running = this.isConnected;
    if (running !== this._wasRunning) {
      this._wasRunning = running;
      this.emit(running ? 'connected' : 'disconnected');
    }
    this._pollTimer = setTimeout(() => this._tick(), POLL_MS);
  }

  /**
   * Add a song to KaraFun's queue by writing directly to the SQLite DB.
   *
   * @param {number} karafunSongId  — numeric song_id from KaraFun's song table
   * @param {string} singerName     — displayed in KaraFun's queue
   * @returns {string}              — the item_id we assigned (as string, for API compat)
   */
  addToQueue(karafunSongId, singerName) {
    if (!this.isConnected) {
      throw new Error('KaraFun is not running');
    }

    // Retry up to 6 times — SQLite "database is locked/busy" is transient
    // when KaraFun holds a write lock. We wait generously between retries.
    const MAX_ATTEMPTS = 6;
    const RETRY_DELAY_MS = 2000;
    let lastErr;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const until = Date.now() + RETRY_DELAY_MS;
        while (Date.now() < until) { /* spin — better-sqlite3 is sync-only */ }
        console.log(`[karafun-db] Retry ${attempt}/${MAX_ATTEMPTS - 1} after lock…`);
      }

      let db;
      try {
        // timeout: SQLite will internally wait up to 20s before surfacing BUSY.
        db = new Database(DB_PATH, { fileMustExist: true, timeout: 20000 });
        db.pragma('busy_timeout = 20000');

        // Enable WAL mode — reduces contention between our writes and KaraFun's
        // reads. WAL lets readers and writers proceed concurrently; journal mode
        // requires an exclusive lock. Safe to set even if KaraFun already uses WAL.
        try { db.pragma('journal_mode = WAL'); } catch (_) { /* ignore if locked */ }

        // Use BEGIN IMMEDIATE instead of DEFERRED (the default).
        // DEFERRED starts in read mode and upgrades to write when it hits the
        // INSERT — exactly the moment another writer can have snatched the lock,
        // causing SQLITE_BUSY. IMMEDIATE acquires the write lock upfront, so
        // SQLite's internal busy_timeout applies right from the start.
        let nextId;
        db.exec('BEGIN IMMEDIATE');
        try {
          const row = db.prepare('SELECT MAX(item_id) AS max_id FROM queue_item').get();
          nextId = (row?.max_id || 0) + 1;
          db.prepare(`
            INSERT INTO queue_item
              (item_id, uuid, item_type_id, item_ref_id, origin, singer_name)
            VALUES
              (@item_id, @uuid, 1, @song_id, 'app', @singer_name)
          `).run({
            item_id:     nextId,
            uuid:        randomUUID(),
            song_id:     karafunSongId,
            singer_name: singerName || null,
          });
          db.exec('COMMIT');
        } catch (txErr) {
          try { db.exec('ROLLBACK'); } catch (_) {}
          throw txErr;
        }

        console.log(`[karafun-db] Queued song ${karafunSongId} for "${singerName}" → item_id ${nextId}`);
        return String(nextId);

      } catch (err) {
        lastErr = err;
        console.warn(`[karafun-db] addToQueue attempt ${attempt + 1} failed:`, err.message);
      } finally {
        try { db?.close(); } catch {}
      }
    }

    throw lastErr;
  }

  /**
   * Search KaraFun's local song library.
   * Returns up to 20 matches for artist+title queries.
   *
   * @param {string} query
   * @returns {Array<{song_id, artist, title}>}
   */
  searchSongs(query) {
    if (!fs.existsSync(DB_PATH)) return [];
    const db = new Database(DB_PATH, { readonly: true, timeout: 3000 });
    try {
      const like = `%${query.replace(/%/g, '').replace(/_/g, '')}%`;
      return db.prepare(`
        SELECT song_id, artist, title
        FROM song
        WHERE artist LIKE ? OR title LIKE ?
        ORDER BY title
        LIMIT 20
      `).all(like, like);
    } catch (err) {
      console.error('[karafun-db] searchSongs error:', err.message);
      return [];
    } finally {
      db.close();
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }
}

module.exports = new KarafunDB();
