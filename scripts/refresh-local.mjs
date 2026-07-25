#!/usr/bin/env node
/**
 * refresh-local.mjs
 * Refreshes the sources CI cannot reach — Bazaraki houses, Zyprus houses and
 * Bazaraki plots — merging each into src/data/listings.json and
 * src/data/plots.json in place and leaving every other source untouched.
 *
 * Must be run from a residential connection. Cloudflare serves the managed
 * challenge to every client from a datacenter IP, so update-listings.yml and
 * the plots workflow will never carry these; see README.md.
 *
 * Both Bazaraki scrapers walk the full catalogue (~9,000 houses, ~6,200 plots),
 * so a full run takes roughly 15-20 minutes. Cap it with BAZARAKI_PAGES /
 * BAZARAKI_PLOTS_PAGES / ZYPRUS_MAX_PAGES when testing.
 *
 * Usage:
 *   npm run refresh:local     # then review `git diff --stat` and commit
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scrapeBazaraki } from './scrape-bazaraki.mjs';
import { scrapeZyprus } from './scrape-zyprus.mjs';
import { scrapeBazarakiPlots } from './scrape-bazaraki-plots.mjs';
import { resolveDistrict } from './lib/districts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * Re-scrapes `sources` and swaps their rows into `file`, keeping every other
 * source's rows as they are. A source that returns nothing keeps its existing
 * rows rather than being wiped out — that is the whole point of doing this in
 * place instead of rewriting the file from scratch.
 */
async function refresh(file, label, sources) {
  const dataPath = path.join(root, file);
  const existing = JSON.parse(readFileSync(dataPath, 'utf-8'));

  const fresh = [];
  const refreshed = [];
  for (const [name, fn] of sources) {
    console.log(`Scraping ${label}: ${name}...`);
    try {
      const data = await fn();
      console.log(`  -> ${data.length} listings`);
      if (data.length === 0) {
        console.error(`  !! ${name} returned nothing — keeping its existing rows.`);
        continue;
      }
      fresh.push(...data);
      refreshed.push(name);
    } catch (err) {
      console.error(`  !! ${name} failed: ${err.message} — keeping its existing rows.`);
    }
  }

  if (refreshed.length === 0) {
    console.error(`  !! Nothing refreshed for ${label}.`);
    return false;
  }

  const kept = existing.filter((l) => !refreshed.includes(l.source));
  const merged = [...kept, ...fresh.map((l) => ({ ...l, district: resolveDistrict(l) }))];

  // Link-level dedupe only; the cross-source pass belongs to the full run.
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
    `  ${label}: ${refreshed.join(' + ')} ${before} -> ${fresh.length}; ` +
      `total ${existing.length} -> ${deduped.length}\n`
  );
  return true;
}

const didHouses = await refresh('src/data/listings.json', 'houses', [
  ['Bazaraki', scrapeBazaraki],
  ['Zyprus', scrapeZyprus],
]);

const didPlots = await refresh('src/data/plots.json', 'plots', [
  ['Bazaraki', scrapeBazarakiPlots],
]);

if (!didHouses && !didPlots) {
  console.error('Nothing refreshed at all. Are you on a residential connection?');
  process.exit(1);
}

if (didHouses) await import('./build-page.mjs');
if (didPlots) await import('./build-plots-page.mjs');

console.log('\nDone. Review `git diff --stat` and commit.');
process.exit(0);
