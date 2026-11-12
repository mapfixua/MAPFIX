'use strict';

const crypto = require('crypto');
const { getServiceRoleClient } = require('./supabaseClient.js');

const TABLE = 'places_response_cache';

function hashKey(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex');
}

/**
 * Places responses live in Supabase. The serverless disk disappears between
 * chunks, and a cache miss would bill Text Search again for the same tile.
 * Failures are ignored so a missing table does not abort a chunk.
 */
function createSupabasePlacesCache() {
  const client = getServiceRoleClient();
  if (!client) return null;
  return {
    async get(key) {
      const cacheKey = hashKey(key);
      const { data, error } = await client
        .from(TABLE)
        .select('payload')
        .eq('cache_key', cacheKey)
        .maybeSingle();
      if (error || !data) return null;
      return data.payload;
    },
    async set(key, value) {
      if (value == null) return;
      const cacheKey = hashKey(key);
      const kind = String(key).startsWith('details:') ? 'details' : 'text';
      await client.from(TABLE).upsert(
        { cache_key: cacheKey, kind, payload: value },
        { onConflict: 'cache_key' }
      );
    },
  };
}

module.exports = {
  createSupabasePlacesCache,
  hashKey,
};
