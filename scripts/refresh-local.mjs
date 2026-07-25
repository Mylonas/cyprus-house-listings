#!/usr/bin/env node
/**
 * refresh-local.mjs
 * Refreshes the two sources CI cannot reach — Bazaraki and Zyprus — and merges
 * them into src/data/listings.json in place, leaving the other 15 sources'
 * listings untouched.
 *
 * Must be run from a residential connection. Cloudflare serves both sites'
 * managed challenge to every client from a datacenter IP, so the 6-hourly
 * update-listings.yml workflow will never carry these two; see README.md.
 *
 * Usage:
 *   npm run refresh:local     # then review `git diff --stat` and commit
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scrapeBazaraki } from './scrape-bazaraki.mjs';
import { scrapeZyprus } from './scrape-zyprus.mjs';
import { resolveDistrict } from './lib/districts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataPath = path.join(root, 'src/data/listings.json');

const SOURCES = [
  ['Bazaraki', scrapeBazaraki],
  ['Zyprus', scrapeZyprus],
];

const existing = JSON.parse(readFileSync(dataPath, 'utf-8'));

const fresh = [];
const refreshed = [];
for (const [name, fn] of SOURCES) {
  console.log(`Scraping ${name}...`);
  try {
    const data = await fn();
    console.log(`  -> ${data.length} listings`);
    // Keeping the old rows on an empty scrape is the whole point: a challenge
    // must not silently wipe a source out of the dataset.
    if (data.length === 0) {
      console.error(`  !! ${name} returned nothing — keeping its existing listings.`);
      continue;
    }
    fresh.push(...data);
    refreshed.push(name);
  } catch (err) {
    console.error(`  !! ${name} failed: ${err.message} — keeping its existing listings.`);
  }
}

if (refreshed.length === 0) {
  console.error('\nNeither source refreshed. Are you on a residential connection?');
  process.exit(1);
}

const kept = existing.filter((l) => !refreshed.includes(l.source));
const merged = [...kept, ...fresh.map((l) => ({ ...l, district: resolveDistrict(l) }))];

// Same link-level dedupe scrape-all applies; the cross-source pass is left to
// the full run, since only two sources are in play here.
const seen = new Set();
const deduped = merged.filter((l) => {
  const key = (l.link || '').toLowerCase().replace(/\/+$/, '');
  if (key && seen.has(key)) return false;
  if (key) seen.add(key);
  return true;
});

writeFileSync(dataPath, JSON.stringify(deduped, null, 1), 'utf-8');

const before = existing.filter((l) => refreshed.includes(l.source)).length;
console.log(
  `\nRefreshed ${refreshed.join(' + ')}: ${before} -> ${fresh.length} listings.` +
    `\nTotal ${existing.length} -> ${deduped.length}. Rebuilding page...`
);

await import('./build-page.mjs');
console.log('\nDone. Review `git diff --stat` and commit.');
process.exit(0);
