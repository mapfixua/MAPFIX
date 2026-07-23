#!/usr/bin/env node
'use strict';

/**
 * CLI: import places into data.json mockLocations
 *
 * Examples:
 *   node scripts/import-places.js --source osm --city kotsyubynske --category beauty
 *   node scripts/import-places.js --source osm --city kotsyubynske --category auto --write
 *   node scripts/import-places.js --source csv --file imports/kotsyubynske.csv --category beauty --write
 *   node scripts/import-places.js --source places --city kotsyubynske --category beauty --write
 */

const fs = require('fs');
const path = require('path');
const {
  fetchOsmPlaces,
  fetchGooglePlaces,
  loadLocationsFromFile,
  mergeLocations,
  CITY_PRESETS,
  CATEGORY_OSM_FILTERS,
} = require('../places-import.js');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const eq = t.indexOf('=');
      if (eq === -1) return;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    });
}

function parseArgs(argv) {
  const args = {
    source: 'osm',
    city: 'kotsyubynske',
    category: 'beauty',
    file: '',
    write: false,
    out: '',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') args.write = true;
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--city') args.city = argv[++i];
    else if (a === '--category') args.category = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`
Usage:
  node scripts/import-places.js --source osm|places|csv|json [options]

Options:
  --city kotsyubynske|kyiv   City preset (default: kotsyubynske)
  --category beauty|auto|... Mapfix category (default: beauty)
  --file path.csv|path.json  For --source csv|json
  --write                    Merge into data.json (otherwise dry-run)
  --out path.json            Also write imported batch to a file

Cities: ${Object.keys(CITY_PRESETS).join(', ')}
Categories: ${Object.keys(CATEGORY_OSM_FILTERS).join(', ')}
`);
    return;
  }

  const root = path.join(__dirname, '..');
  const dataFile = path.join(root, 'data.json');
  let incoming = [];
  let meta = {};

  if (args.source === 'osm') {
    console.log(`[import] OSM Overpass: ${args.city} / ${args.category}`);
    const result = await fetchOsmPlaces({ city: args.city, category: args.category });
    incoming = result.locations;
    meta = result;
  } else if (args.source === 'places' || args.source === 'google') {
    console.log(`[import] Google Places: ${args.city} / ${args.category}`);
    const result = await fetchGooglePlaces({ city: args.city, category: args.category });
    incoming = result.locations;
    meta = result;
  } else if (args.source === 'csv' || args.source === 'json') {
    if (!args.file) throw new Error('--file is required for csv/json source');
    console.log(`[import] File: ${args.file}`);
    incoming = loadLocationsFromFile(args.file, args.category);
    meta = { source: args.source, locations: incoming };
  } else {
    throw new Error(`Unknown source: ${args.source}`);
  }

  console.log(`[import] Found ${incoming.length} places`);
  incoming.slice(0, 5).forEach((l) => {
    console.log(`  - ${l.title} (${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}) ${l.phone || ''}`);
  });
  if (incoming.length > 5) console.log(`  … and ${incoming.length - 5} more`);

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, JSON.stringify(incoming, null, 2), 'utf8');
    console.log(`[import] Batch saved: ${outPath}`);
  }

  if (!args.write) {
    console.log('[import] Dry-run only. Add --write to merge into data.json');
    return;
  }

  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  if (!Array.isArray(data.mockLocations)) data.mockLocations = [];

  const merged = mergeLocations(data.mockLocations, incoming);
  data.mockLocations = merged.locations;
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');

  console.log(
    `[import] Wrote data.json: +${merged.added.length} added, ${merged.skipped.length} skipped, ${merged.updated.length} updated`
  );
  console.log(`[import] Total locations: ${data.mockLocations.length}`);
  console.log(`[import] Source: ${meta.source || args.source}`);
}

main().catch((err) => {
  console.error('[import] Failed:', err.message);
  process.exit(1);
});
