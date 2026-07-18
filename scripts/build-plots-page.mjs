#!/usr/bin/env node
/**
 * build-plots-page.mjs
 * Reads src/data/plots.json, injects it into src/template/plots.html, and writes
 * the static, deployable public/plots.html. Plots counterpart of build-page.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const dataPath = path.join(root, 'src/data/plots.json');
const templatePath = path.join(root, 'src/template/plots.html');
const outPath = path.join(root, 'public/plots.html');

const listings = JSON.parse(readFileSync(dataPath, 'utf-8'));
const template = readFileSync(templatePath, 'utf-8');

const html = template.replace('__DATA__', JSON.stringify(listings));
writeFileSync(outPath, html, 'utf-8');

console.log(`Built public/plots.html with ${listings.length} plots.`);
