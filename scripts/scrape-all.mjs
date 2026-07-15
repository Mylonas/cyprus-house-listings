#!/usr/bin/env node
/**
 * scrape-all.mjs
 * Runs all four source scrapers, merges the results, writes src/data/listings.json,
 * then rebuilds public/index.html via build-page.mjs.
 *
 * This is the script GitHub Actions runs on the update-listings.yml schedule.
 * It is intentionally resilient: if one source fails (site down, markup change),
 * the others still complete and the run does not fail outright — it exits
 * non-zero only if every source failed, so the watchdog workflow can catch it.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scrapeAltamira } from './scrape-altamira.mjs';
import { scrapeBazaraki } from './scrape-bazaraki.mjs';
import { scrapeEauction } from './scrape-eauction.mjs';
import { scrapeZyprus } from './scrape-zyprus.mjs';
import { scrapeBidx1 } from './scrape-bidx1.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outPath = path.join(root, 'src/data/listings.json');

const sources = [
  ['Altamira', scrapeAltamira],
  ['Bazaraki', scrapeBazaraki],
  ['eAuction', scrapeEauction],
  ['Zyprus', scrapeZyprus],
  ['BidX1', scrapeBidx1],
];

const results = [];
let successCount = 0;

for (const [name, fn] of sources) {
  try {
    console.log(`Scraping ${name}...`);
    const data = await fn();
    console.log(`  -> ${data.length} listings`);
    results.push(...data);
    successCount++;
  } catch (err) {
    console.error(`  !! ${name} failed:`, err.message);
  }
}

if (successCount === 0) {
  console.error('All sources failed — leaving listings.json untouched.');
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf-8');
console.log(`Wrote ${results.length} total listings to src/data/listings.json (${successCount}/${sources.length} sources succeeded).`);

// Re