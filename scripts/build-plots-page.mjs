#!/usr/bin/env node
/**
 * build-plots-page.mjs
 * Reads src/data/plots.json, injects it into src/template/plots.html, and writes
 * the static, deployable public/plots.html. Plots counterpart of build-page.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { slim, embed, inject } from './lib/payload.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const dataPath = path.join(root, 'src/data/plots.json');
const templatePath = path.join(root, 'src/template/plots.html');
const outPath = path.join(root, 'public/plots.html');

// Same contract as build-page.mjs: only what the plots template reads. Plots
// carry a lot of house-shaped fields the page never shows (baths, buildYear,
// kind, geoZoom, registration, status); beds and houseSqm survive only because
// the map popup mentions them for plots that come with a building.
const FIELDS = [
  'source', 'title', 'link', 'image', 'location', 'district', 'ref',
  'price', 'priceDisplay', 'plotSqm', 'plotType', 'zone', 'auctionDate',
  'beds', 'houseSqm', 'posted', 'postedTs', 'lat', 'lng',
];

const listings = JSON.parse(readFileSync(dataPath, 'utf-8'));
const template = readFileSync(templatePath, 'utf-8');

const html = inject(template, embed(slim(listings, FIELDS)));
writeFileSync(outPath, html, 'utf-8');

const mb = (Buffer.byteLength(html) / 1048576).toFixed(1);
console.log(`Built public/plots.html with ${listings.length} plots (${mb} MB).`);
