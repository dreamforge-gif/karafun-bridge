'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fiegchlcocanlwkwwvrz.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpZWdjaGxjb2Nhbmx3a3d3dnJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMTY5MTAsImV4cCI6MjA5MTY5MjkxMH0.nsJahXm0wUrPlcshNRxrJMlDZzpgp4zm0wa7crx2ASk';

const POLL_INTERVAL_MS = 3000; // poll every 3 seconds

let _client = null;
let _pollTimer = null;
let _seenIds = new Set(); // track song IDs already surfaced to avoid duplicates

function init() {
  // No WebSocket realtime options needed — we use REST polling
  _client = createClient(SUPABASE_URL, ANON_KEY, {
    realtime: { enabled: false },
  });
}

function getClient() {
  if (!_client) throw new Error('Supabase client not initialised — call init() first');
  return _client;
}

// ── Polling-based queue subscription ─────────────────────────────────────────
// Uses REST polling (3s interval) instead of WebSocket realtime.
// WebSocket connections consistently time out in Electron on Windows due to
// firewall / network stack issues. REST works fine.
//
// If sessionId is provided, only songs for that specific session are surfaced.
// If sessionId is null, falls back to community-level filtering (all songs for
// the community regardless of session).

function subscribeToQueue(communityId, sessionId, onNewSong, onStatusChange) {
  // Cancel any existing poll before starting a new one
  _stopPoll();
  _seenIds = new Set();

  if (onStatusChange) onStatusChange('SUBSCRIBING', null);

  const client = getClient();

  // Build the seed query (only see songs already there — don't re-alert KJ)
  let seedQ = client
    .from('song_selections')
    .select('id')
    .eq('status', 'submitted');

  if (sessionId) {
    seedQ = seedQ.eq('session_id', sessionId);
  } else {
    seedQ = seedQ.eq('community_id', communityId);
  }

  seedQ.then(({ data, error }) => {
    if (error) {
      console.error('Supabase seed error:', error.message);
      if (onStatusChange) onStatusChange('CHANNEL_ERROR', error.message);
      return;
    }
    (data || []).forEach((r) => _seenIds.add(r.id));
    const filter = sessionId ? `session ${sessionId}` : `community ${communityId}`;
    console.log(`Poll seeded (${filter}) — ${_seenIds.size} existing song(s) ignored`);

    // Flip to "connected"
    if (onStatusChange) onStatusChange('SUBSCRIBED', null);

    // Start polling loop
    _pollTimer = setInterval(
      () => _pollOnce(communityId, sessionId, onNewSong),
      POLL_INTERVAL_MS
    );
  });
}

async function _pollOnce(communityId, sessionId, onNewSong) {
  const client = getClient();

  let q = client
    .from('song_selections')
    .select('*')
    .eq('status', 'submitted')
    .order('created_at', { ascending: true });

  if (sessionId) {
    q = q.eq('session_id', sessionId);
  } else {
    q = q.eq('community_id', communityId);
  }

  const { data, error } = await q;

  if (error) {
    console.error('Poll error:', error.message);
    return; // transient — keep polling
  }

  const newSongs = (data || []).filter((r) => !_seenIds.has(r.id));
  for (const row of newSongs) {
    _seenIds.add(row.id);
    console.log('New song (poll):', row.singer_name, '—', row.song_title);
    onNewSong(row);
  }
}

function _stopPoll() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

function unsubscribe() {
  _stopPoll();
  _seenIds = new Set();
}

// ── Song selections ───────────────────────────────────────────────────────────

async function updateSongStatus(songId, status, karafunQueueId = null) {
  const client = getClient();
  const update = { status };
  if (karafunQueueId !== null) update.karafun_queue_id = karafunQueueId;

  const { error } = await client
    .from('song_selections')
    .update(update)
    .eq('id', songId);

  if (error) throw error;
}

async function deleteSong(songId) {
  const client = getClient();
  const { error } = await client
    .from('song_selections')
    .delete()
    .eq('id', songId);
  if (error) throw error;
  // Also remove from seen set so it doesn't ghost
  _seenIds.delete(songId);
}

// Cancel all submitted songs for a session (called on End Session)
async function cancelSessionSongs(sessionId) {
  const client = getClient();
  const { error } = await client
    .from('song_selections')
    .update({ status: 'cancelled' })
    .eq('session_id', sessionId)
    .eq('status', 'submitted');
  if (error) throw error;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

async function createSession(communityId, hostName, venue) {
  const client = getClient();
  const { data, error } = await client
    .from('karaoke_sessions')
    .insert({
      community_id: communityId,
      host_name:    hostName || null,
      venue:        venue    || null,
      status:       'active',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function endSession(sessionId) {
  const client = getClient();
  const { error } = await client
    .from('karaoke_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', sessionId);
  if (error) throw error;
}

// ── Communities ───────────────────────────────────────────────────────────────

async function getCommunities() {
  const client = getClient();
  const { data, error } = await client
    .from('adalo_communities')
    .select('id, name')
    .order('name');
  if (error) throw error;
  return data || [];
}

module.exports = {
  init, getClient,
  subscribeToQueue, updateSongStatus, deleteSong, cancelSessionSongs,
  createSession, endSession,
  getCommunities, unsubscribe,
};
