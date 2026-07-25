#!/usr/bin/env node
/**
 * build-page.mjs
 * Reads src/data/listings.json, injects it into src/template/index.template.html,
 * and writes the static, deployable public/index.html.
 *
 * Run after any scrape-*.mjs script updates listings.json, or standalone with:
 *   node scripts/build-page.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const dataPath = path.join(root, 'src/data/listings.json');
const templatePath = path.join(root, 'src/template/page.html');
const outPath = path.join(root, 'public/index.html');

const listings = JSON.parse(readFileSync(dataPath, 'utf-8'));
const template = readFileSync(templatePath, 'utf-8');

// The page is one self-contained file with the data inlined, so every byte here
// is a byte the visitor downloads. `images` (6.9 photos per listing on average)
// is 57% of the payload and the template only ever reads `image`, the first one
// — inlining the rest was costing ~10 MB for nothing. It stays in listings.json,
// where enrichment and future galleries can use it.
const slim = listings.map(({ images, ...rest }) => rest);

const html = template.replace('__DATA__', JSON.stringify(slim));
writeFileSync(outPath, html, 'utf-8');

const mb = (Buffer.byteLength(html) / 1048576).toFixed(1);
console.log(`Built public/index.html with ${listings.length} listings (${mb} MB).`);
