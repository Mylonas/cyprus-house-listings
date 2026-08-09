#!/usr/bin/env node
/**
 * build-faq-page.mjs
 * Renders src/template/faq.html into public/faq.html, injecting the planning
 * zone reference (src/data/planning-zones.json) plus a count of how many
 * listings actually carry each zone code.
 *
 * The counts are the reason this is generated rather than hand-written: they
 * show which codes matter in practice, and they go stale on every scrape.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { embed, inject } from './lib/payload.mjs';
import { normalise, zoneCodes } from './lib/zones.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const zonesPath = path.join(root, 'src/data/planning-zones.json');
const templatePath = path.join(root, 'src/template/faq.html');
const outPath = path.join(root, 'public/faq.html');

const ref = JSON.parse(readFileSync(zonesPath, 'utf-8'));

// Canonicalisation of the advertiser-typed `zone` field lives in lib/zones.mjs,
// shared with the plots page's zone filter. Here we only care about the codes
// the Policy Statement table actually documents — Local Plan codes (Κα, Εβ,
// Βα…) resolve fine but have no national figures to show against.
const official = new Set(ref.zones.map(z => normalise(z.code)));
const codesIn = raw =>
  new Set([...zoneCodes(raw)].filter(c => official.has(normalise(c))));

const rows = ['src/data/plots.json', 'src/data/listings.json']
  .flatMap(f => JSON.parse(readFileSync(path.join(root, f), 'utf-8')));

const counts = {};
let withZone = 0, matched = 0;
for (const r of rows) {
  if (!r.zone) continue;
  withZone++;
  const found = codesIn(r.zone);
  if (found.size) matched++;
  for (const c of found) counts[c] = (counts[c] || 0) + 1;
}

// Keys are normalised; the table looks them up by the code as printed.
const byPrinted = {};
for (const z of ref.zones) {
  const n = counts[normalise(z.code)];
  if (n) byPrinted[z.code] = n;
}

const payload = { ...ref, counts: byPrinted, withZone, matched, totalPlots: rows.length };
const html = inject(readFileSync(templatePath, 'utf-8'), embed(payload));
writeFileSync(outPath, html, 'utf-8');

const top = Object.entries(byPrinted).sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log(`Built public/faq.html — ${ref.zones.length} zones, ${ref.families.length} families.`);
console.log(`  ${matched} of ${withZone} listings with a zone matched an official code.`);
console.log(`  most common: ${top.map(([c, n]) => `${c} (${n})`).join(', ')}`);
