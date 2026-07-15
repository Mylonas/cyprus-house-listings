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

const html = template.replace('__DATA__', JSON.stringify(listings));
writeFileSync(outPath, html, 'utf-8');

console.log(`Built public/index.html with ${listings.length} listings.`);
