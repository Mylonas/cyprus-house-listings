#!/usr/bin/env node
/**
 * build-page.mjs
 * Reads src/data/listings.json, injects it into src/template/page.html,
 * and writes the static, deployable public/index.html.
 *
 * Run after any scrape-*.mjs script updates listings.json, or standalone with:
 *   node scripts/build-page.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { slim, embed, inject } from './lib/payload.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const dataPath = path.join(root, 'src/data/listings.json');
const templatePath = path.join(root, 'src/template/page.html');
const outPath = path.join(root, 'public/index.html');

// Every field the house template reads, in cards, filters, sorting and map
// popups. Anything not listed here stays in listings.json for enrichment and
// analysis but never reaches the browser. Notably absent: `images` (the full
// photo array — the card only ever shows `image`, the first one), plus
// geoZoom, agent, registration, planningZone, floors, status and newBuild.
const FIELDS = [
  'source', 'title', 'link', 'image', 'location', 'district', 'ref',
  'price', 'priceDisplay', 'beds', 'baths', 'houseSqm', 'plotSqm',
  'buildYear', 'propertyType', 'share', 'auctionDate',
  'posted', 'postedTs', 'lat', 'lng',
];

const listings = JSON.parse(readFileSync(dataPath, 'utf-8'));
const template = readFileSync(templatePath, 'utf-8');

const html = inject(template, embed(slim(listings, FIELDS)));
writeFileSync(outPath, html, 'utf-8');

const mb = (Buffer.byteLength(html) / 1048576).toFixed(1);
console.log(`Built public/index.html with ${listings.length} listings (${mb} MB).`);
