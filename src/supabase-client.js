'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fiegchlcocanlwkwwvrz.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpZWdjaGxjb2Nhbmx3a3d3dnJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMTY5MTAsImV4cCI6MjA5MTY5MjkxMH0.nsJahXm0wUrPlcshNRxrJMlDZzpgp4zm0wa7crx2ASk';

let _client = null;
let _activeChannel = null;

function init() {
  _client = createClient(SUPABASE_URL, ANON_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

function getClient() {
  if (!_client) throw new Error('Supabase client not initialised — call init() first');
  return _client;
}

// ── Realtime subscription ─────────────────────────────────────────────────────

function subscribeToQueue(communityId, onNewSong, onStatusChange) {
  const client = getClient();

  if (_activeChannel) {
    client.removeChannel(_activeChannel);
    _activeChannel = null;
  }

  // Note: we intentionally omit the server-side filter and match community_id
  // client-side to avoid CHANNEL_ERROR from filter type-mismatch issues.
  const channel = client
    .channel('song_queue_all')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'song_selections',
      },
      (payload) => {
        const row = payload.new;
        // eslint-disable-next-line eqeqeq
        if (row && row.status === 'submitted' && row.community_id == communityId) {
          onNewSong(row);
        }
      }
    )
    .subscribe((status, err) => {
      console.log('Supabase channel status:', status, err || '');
      if (onStatusChange) onStatusChange(status, err);
    });

  _activeChannel = channel;
  return channel;
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

async function createSession(communityId, hostName) {
  const client = getClient();
  const { data, error } = await client
    .from('karaoke_sessions')
    .insert({
      community_id: communityId,
      host_name: hostName || null,
      status: 'active',
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

function unsubscribe() {
  if (_client && _activeChannel) {
    _client.removeChannel(_activeChannel);
    _activeChannel = null;
  }
}

module.exports = {
  init, getClient,
  subscribeToQueue, updateSongStatus, deleteSong, cancelSessionSongs,
  createSession, endSession,
  getCommunities, unsubscribe,
};
