#!/usr/bin/env node
/**
 * harvest-eauction-pdfs.mjs
 * Out-of-band enrichment harvester for eAuction Cyprus. For every biddable
 * Residence auction it downloads the legal-notice / photo-appendix PDF and
 * ingests everything the PDF carries that the XHR list endpoint does not:
 *
 *   - Real property PHOTOS embedded in the `...ph.pdf` appendix, isolated from
 *     the cadastral maps / form banners by an HSV discriminator (saturation
 *     mean >= 12 and white-fraction <= 0.5), saved as static assets under
 *     public/eauction-photos/<code>-<n>.jpg.
 *   - The Greek legal table (form FR.08): per-lot registration number, district,
 *     location, property type (Είδος), plot/land area (Έκταση τ.μ.), ownership
 *     share (Εγγεγραμμένο συμφέρον, e.g. 1/1, 1/2) and reserve price — read by
 *     column x-position so the fraction columns don't collide.
 *
 * Results are written to src/data/eauction-details.json (keyed by auction code),
 * which scrape-eauction.mjs merges into each listing.
 *
 * Access: eAuction sits behind Imperva. The list comes from the unprotected XHR
 * endpoint (via scrapeEauction); the PDFs live on challenge-protected routes, so
 * we clear the challenge once with a stealth browser and download same-origin.
 * Gentle by design: serial, with delays, to avoid an Imperva IP block.
 *
 * Env:
 *   EAUCTION_HARVEST_LIMIT - cap listings processed (default: all)
 */
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { scrapeEauction } from './scrape-eauction.mjs';

chromium.use(stealth());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const cachePath = path.join(root, 'src/data/eauction-details.json');
const photoDir = path.join(root, 'public/eauction-photos');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LIMIT = process.env.EAUCTION_HARVEST_LIMIT ? Number(process.env.EAUCTION_HARVEST_LIMIT) : Infinity;

const PROPERTY_TYPES = ['ΚΑΤΟΙΚΙΑ', 'ΔΙΑΜΕΡΙΣΜΑ', 'ΟΙΚΟΠΕΔΟ', 'ΧΩΡΑΦΙ', 'ΟΙΚΙΑ', 'ΒΙΛΑ', 'ΚΑΤΑΣΤΗΜΑ', 'ΓΡΑΦΕΙΟ', 'ΑΠΟΘΗΚΗ', 'ΤΕΜΑΧΙΟ', 'ΓΗ', 'ΜΕΖΟΝΕΤΑ'];
const TYPE_EN = {
  ΚΑΤΟΙΚΙΑ: 'Residence', ΔΙΑΜΕΡΙΣΜΑ: 'Apartment', ΟΙΚΟΠΕΔΟ: 'Building plot',
  ΧΩΡΑΦΙ: 'Field', ΟΙΚΙΑ: 'House', ΒΙΛΑ: 'Villa', ΚΑΤΑΣΤΗΜΑ: 'Shop',
  ΓΡΑΦΕΙΟ: 'Office', ΑΠΟΘΗΚΗ: 'Warehouse', ΤΕΜΑΧΙΟ: 'Parcel', ΓΗ: 'Land', ΜΕΖΟΝΕΤΑ: 'Maisonette',
};

// ---- PDF parsing -----------------------------------------------------------

async function parsePdf(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const rows = [];
  const photos = [];

  // Page 1 (and any table pages): read the property table by column x-position.
  for (let pn = 1; pn <= doc.numPages; pn++) {
    const page = await doc.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(i => i.str.trim())
      .map(i => ({ s: i.str.trim(), x: Math.round(i.transform[4]), y: Math.round(vp.height - i.transform[5]) }));

    // Locate table columns by their header labels (x varies between PDFs), so
    // the fraction columns (share vs registration) don't get confused.
    const headerX = (needle) => { const h = items.find(i => i.s.includes(needle)); return h ? h.x : null; };
    const regX = headerX('Εγγραφή');       // Αριθμός Εγγραφής
    const areaX = headerX('Έκταση');        // Έκταση τ.μ.
    const shareX = headerX('συμφέρον') ?? headerX('Εγγεγραμμένο'); // Εγγεγραμμένο συμφέρον
    const typeX = headerX('Είδος');
    const near = (items2, cx, tol = 40) => cx == null ? [] : items2.filter(i => Math.abs(i.x - cx) <= tol).map(i => i.s);

    // Data rows start with an "N." / "N.*" α/α marker at the far left (x < 36).
    const rowMarkers = items.filter(i => i.x < 36 && /^\d+\.\*{0,4}$/.test(i.s));
    for (const rm of rowMarkers) {
      const rowItems = items.filter(i => Math.abs(i.y - rm.y) < 22).sort((a, b) => a.x - b.x);
      const reg = near(rowItems, regX, 45).find(s => /^\d+\/\d+$/.test(s)) || null;
      const shareCell = near(rowItems, shareX, 40).find(s => {
        const m = s.match(/^(\d{1,4})\/(\d{1,5})$/);
        return m && Number(m[1]) > 0 && Number(m[1]) <= Number(m[2]);
      }) || null;
      // Area: a plain number (no slash) under the Έκταση header, 1..2,000,000 τ.μ.
      const areaTok = near(rowItems, areaX ?? -999, 40)
        .map(s => s.replace(/\./g, '').replace(',', '.'))
        .find(s => /^\d{1,7}(?:\.\d+)?$/.test(s) && !/\//.test(s));
      const areaNum = areaTok ? Math.round(Number(areaTok)) : null;
      const typeCell = near(rowItems, typeX ?? -999, 55).join(' ');
      const typeGr = PROPERTY_TYPES.find(t => typeCell.includes(t))
        || PROPERTY_TYPES.find(t => rowItems.some(i => i.s.includes(t))) || null;
      rows.push({
        idx: Number(rm.s.match(/^\d+/)[0]),
        reg,
        propertyTypeGr: typeGr,
        propertyType: typeGr ? TYPE_EN[typeGr] : null,
        areaSqm: Number.isFinite(areaNum) && areaNum > 0 && areaNum <= 2000000 ? areaNum : null,
        share: shareCell,
      });
    }

    // Images on this page.
    const ops = await page.getOperatorList();
    const seenNames = new Set();
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn !== OPS.paintImageXObject && fn !== OPS.paintJpegXObject) continue;
      const name = ops.argsArray[i][0];
      if (typeof name !== 'string' || seenNames.has(name)) continue;
      seenNames.add(name);
      const img = await getImage(page, name);
      if (!img || !img.data) continue;
      const rgba = toRgba(img);
      const stat = analyze(rgba, img.width, img.height);
      const isPhoto = stat.sat >= 12 && stat.white <= 0.5 && img.width >= 200 && img.height >= 200;
      if (isPhoto) photos.push({ rgba, width: img.width, height: img.height });
    }
  }
  return { rows, photos };
}

function getImage(page, name) {
  return new Promise(res => {
    let done = false;
    const cb = o => { if (!done) { done = true; res(o); } };
    setTimeout(() => cb(null), 4000);
    try { page.objs.get(name, cb); } catch { cb(null); }
  });
}

function toRgba(img) {
  const { width: w, height: h, kind, data } = img;
  if (kind === 3) return data; // RGBA
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (kind === 2) { // RGB
    for (let p = 0; p < w * h; p++) { rgba[p * 4] = data[p * 3]; rgba[p * 4 + 1] = data[p * 3 + 1]; rgba[p * 4 + 2] = data[p * 3 + 2]; rgba[p * 4 + 3] = 255; }
  } else { // grayscale
    for (let p = 0; p < w * h; p++) { const v = data[p] || 0; rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255; }
  }
  return rgba;
}

function analyze(rgba, w, h) {
  let satSum = 0, white = 0, n = 0;
  const step = Math.max(1, Math.floor((w * h) / 20000));
  for (let i = 0; i < w * h; i += step) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx === 0 ? 0 : (mx - mn) / mx * 100;
    if (mx > 235 && (mx - mn) < 15) white++;
    n++;
  }
  return { sat: satSum / n, white: white / n };
}

// ---- Harvest ---------------------------------------------------------------

async function main() {
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf-8')) : {};
  mkdirSync(photoDir, { recursive: true });

  console.error('Fetching biddable eAuction list...');
  const listings = (await scrapeEauction()).filter(l => l.link && /\/Auction\/Details\//.test(l.link)).slice(0, LIMIT);
  console.error(`${listings.length} listings to harvest.`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 }, locale: 'el-GR' });
  const page = await ctx.newPage();

  // Clear the Imperva challenge once.
  await page.goto('https://www.eauction-cy.com/en/Home/HlektronikoiPleistiriasmoi?type=5', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1500); if (!/please wait|just a moment/i.test(await page.title())) break; }

  let harvested = 0, photoCount = 0, dataCount = 0;
  for (const l of listings) {
    const code = l.ref;
    try {
      await page.goto(l.link, { waitUntil: 'domcontentloaded' });
      for (let i = 0; i < 15; i++) { await page.waitForTimeout(1200); if (!/please wait|just a moment/i.test(await page.title())) break; }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(800); // let any post-challenge redirect settle

      let pdfUrls = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          pdfUrls = await page.evaluate(() =>
            [...new Set([...document.querySelectorAll('a')].filter(a => /GetFile/i.test(a.href)).map(a => a.href))]
          );
          break;
        } catch { await page.waitForTimeout(1500); } // context destroyed by a redirect; retry
      }
      if (pdfUrls.length === 0) { console.error(`  ${code}: no PDF`); continue; }

      // Download + parse each PDF; merge rows/photos.
      const allRows = [];
      const allPhotos = [];
      for (const url of pdfUrls) {
        const b64 = await page.evaluate(async (u) => {
          const r = await fetch(u); if (!r.ok) return null;
          const bytes = new Uint8Array(await r.arrayBuffer());
          let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          return btoa(bin);
        }, url);
        if (!b64) continue;
        const buf = Buffer.from(b64, 'base64');
        if (buf.slice(0, 4).toString() !== '%PDF') continue;
        const { rows, photos } = await parsePdf(buf);
        allRows.push(...rows);
        allPhotos.push(...photos);
      }

      // Map this code's lot: suffix -00N -> row idx N (fallback: first row).
      const suffix = (code.match(/-(\d+)$/) || [])[1];
      const wantIdx = suffix ? Number(suffix) : 1;
      const row = allRows.find(r => r.idx === wantIdx) || allRows[0] || null;

      // Save photos (shared across the property's lots).
      const savedPhotos = [];
      for (let i = 0; i < allPhotos.length; i++) {
        const p = allPhotos[i];
        const file = path.join(photoDir, `${code}-${i + 1}.jpg`);
        await sharp(Buffer.from(p.rgba), { raw: { width: p.width, height: p.height, channels: 4 } })
          .jpeg({ quality: 82 }).toFile(file);
        savedPhotos.push(`/eauction-photos/${code}-${i + 1}.jpg`);
      }

      const enr = { ...(cache[code] || {}) };
      if (savedPhotos.length) { enr.image = savedPhotos[0]; enr.images = savedPhotos; photoCount++; }
      if (row) {
        if (row.areaSqm) enr.plotSqm = row.areaSqm;
        if (row.share) enr.share = row.share;
        if (row.propertyType) enr.propertyType = row.propertyType;
        if (row.reg) enr.registration = row.reg;
        dataCount++;
      }
      cache[code] = enr;
      harvested++;
      console.error(`  ${code}: ${savedPhotos.length} photo(s), share=${row?.share || '-'}, area=${row?.areaSqm || '-'}, type=${row?.propertyType || '-'}`);
    } catch (err) {
      console.error(`  ${code}: ERROR ${err.message}`);
    }
    await page.waitForTimeout(1500); // gentle
  }

  await browser.close();
  writeFileSync(cachePath, JSON.stringify(cache, null, 1), 'utf-8');
  console.error(`\nHarvested ${harvested} listings: ${photoCount} with photos, ${dataCount} with table data. Wrote ${cachePath}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  process.exit(0);
}
