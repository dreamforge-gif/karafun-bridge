'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const KARAFUN_WS_URL = 'ws://localhost:57921';
const RETRY_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

class KarafunClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._connected = false;
    this._retryTimer = null;
    this._pendingRequests = new Map(); // msgId -> { resolve, reject, timer }
    this._msgIdCounter = 1;
    this._destroyed = false;
  }

  get isConnected() {
    return this._connected;
  }

  /**
   * Start connecting to Karafun. Retries automatically every 5s if not running.
   * Resolves on first successful connection.
   */
  connect() {
    return new Promise((resolve) => {
      if (this._connected) {
        resolve();
        return;
      }
      // One-time listener for the first connection
      this.once('connected', resolve);
      this._attemptConnect();
    });
  }

  _attemptConnect() {
    if (this._destroyed) return;
    if (this._ws) {
      try { this._ws.terminate(); } catch (_) {}
      this._ws = null;
    }

    const ws = new WebSocket(KARAFUN_WS_URL);
    this._ws = ws;

    ws.on('open', () => {
      this._connected = true;
      this._clearRetryTimer();
      this.emit('connected');
    });

    ws.on('message', (data) => {
      this._handleMessage(data);
    });

    ws.on('close', () => {
      const wasConnected = this._connected;
      this._connected = false;
      this._ws = null;
      this._rejectAllPending(new Error('Karafun WebSocket closed'));
      if (wasConnected) {
        this.emit('disconnected');
      }
      this._scheduleRetry();
    });

    ws.on('error', (err) => {
      // suppress — close event will follow
      if (!this._connected) {
        // still in connecting state; retry after interval
        this._scheduleRetry();
      } else {
        this.emit('error', err);
      }
    });
  }

  _scheduleRetry() {
    if (this._destroyed || this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._attemptConnect();
    }, RETRY_INTERVAL_MS);
  }

  _clearRetryTimer() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { id, result, error } = msg;
    if (id == null) return;

    const pending = this._pendingRequests.get(id);
    if (!pending) return;
    this._pendingRequests.delete(id);
    clearTimeout(pending.timer);

    if (error) {
      pending.reject(new Error(error.message || JSON.stringify(error)));
    } else {
      pending.resolve(result);
    }
  }

  _rejectAllPending(err) {
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pendingRequests.clear();
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this._ws) {
        reject(new Error('Karafun is not connected'));
        return;
      }
      const id = this._msgIdCounter++;
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Karafun request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this._pendingRequests.set(id, { resolve, reject, timer });

      try {
        this._ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this._pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Add a song to the Karafun queue.
   * @param {number} karafunSongId  - numeric song ID from Karafun library
   * @param {string} singerName     - display name shown in Karafun
   * @returns {Promise<string>}     - the queueId assigned by Karafun
   */
  async addToQueue(karafunSongId, singerName) {
    const result = await this._send('addToQueue', {
      id: karafunSongId,
      singer: singerName,
    });
    if (!result || !result.queueId) {
      throw new Error('addToQueue: unexpected response from Karafun');
    }
    return result.queueId;
  }

  /**
   * Retrieve the current Karafun queue.
   * @returns {Promise<Array>}
   */
  async getQueue() {
    const result = await this._send('getQueue', {});
    return result || [];
  }

  /**
   * Remove a song from the Karafun queue by its queueId.
   * @param {string} queueId
   */
  async removeFromQueue(queueId) {
    await this._send('removeFromQueue', { queueId });
  }

  /**
   * Gracefully shut down and stop retrying.
   */
  destroy() {
    this._destroyed = true;
    this._clearRetryTimer();
    this._rejectAllPending(new Error('KarafunClient destroyed'));
    if (this._ws) {
      try { this._ws.terminate(); } catch (_) {}
      this._ws = null;
    }
  }
}

module.exports = new KarafunClient();
