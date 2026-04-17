'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fiegchlcocanlwkwwvrz.supabase.co';

let _client = null;
let _activeChannel = null;

/**
 * (Re-)initialise the Supabase client with the provided anon key.
 * Must be called before any other function.
 * @param {string} anonKey
 */
function init(anonKey) {
  if (!anonKey) throw new Error('Supabase anon key is required');
  _client = createClient(SUPABASE_URL, anonKey, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

/**
 * Returns the current Supabase client. Throws if not initialised.
 */
function getClient() {
  if (!_client) throw new Error('Supabase client not initialised — call init() first');
  return _client;
}

/**
 * Subscribe to INSERT events on song_selections for a given community.
 * Calls onNewSong(row) for each new row with status='submitted'.
 *
 * @param {string}   communityId
 * @param {Function} onNewSong   - (row: object) => void
 * @param {Function} onStatusChange - ('SUBSCRIBED'|'CLOSED'|'CHANNEL_ERROR') => void
 * @returns {RealtimeChannel} - channel (call .unsubscribe() to clean up)
 */
function subscribeToQueue(communityId, onNewSong, onStatusChange) {
  const client = getClient();

  // Clean up any existing subscription first
  if (_activeChannel) {
    client.removeChannel(_activeChannel);
    _activeChannel = null;
  }

  const channel = client
    .channel('song_queue_' + communityId)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'song_selections',
        filter: 'community_id=eq.' + communityId,
      },
      (payload) => {
        const row = payload.new;
        if (row && row.status === 'submitted') {
          onNewSong(row);
        }
      }
    )
    .subscribe((status) => {
      if (onStatusChange) onStatusChange(status);
    });

  _activeChannel = channel;
  return channel;
}

/**
 * Update a song_selection row's status (and optionally karafun_queue_id).
 * @param {string}      songId          - UUID of the song_selection row
 * @param {string}      status          - 'queued' | 'skipped' | etc.
 * @param {string|null} karafunQueueId  - set when status is 'queued'
 */
async function updateSongStatus(songId, status, karafunQueueId = null) {
  const client = getClient();
  const update = { status };
  if (karafunQueueId !== null) {
    update.karafun_queue_id = karafunQueueId;
  }

  const { error } = await client
    .from('song_selections')
    .update(update)
    .eq('id', songId);

  if (error) throw error;
}

/**
 * Fetch communities the anon key has access to, for the settings dropdown.
 * Returns an array of { id, name } objects.
 */
async function getCommunities() {
  const client = getClient();
  const { data, error } = await client
    .from('communities')
    .select('id, name')
    .order('name');

  if (error) throw error;
  return data || [];
}

/**
 * Remove the active realtime subscription without destroying the client.
 */
function unsubscribe() {
  if (_client && _activeChannel) {
    _client.removeChannel(_activeChannel);
    _activeChannel = null;
  }
}

module.exports = { init, getClient, subscribeToQueue, updateSongStatus, getCommunities, unsubscribe };
