#!/usr/bin/env node
/**
 * harvest-eauction.mjs
 * Full-detail harvester for eAuction Cyprus — the official Cyprus Banks
 * Association foreclosure portal. For **every currently advertised auction**
 * (all eleven property subtypes, not just Residence) it opens the auction's
 * detail page and reads everything the list endpoint cannot see:
 *
 *   - the detail page's own structured fields (registered area, registration
 *     number, sheet/plan/plot, address, share, lender, the free-text
 *     "Property's other details" block with the unit's covered area);
 *   - every attachment — PDF legal notice, PDF/Word "additional information"
 *     sheet, Greek and English copies — read with pdfjs for PDFs and with the
 *     dependency-free readers in lib/documents.mjs for .docx/.doc/.rtf;
 *   - every photo: embedded PDF/Word images that pass an HSV discriminator
 *     (real photos, not cadastral maps or form banners) plus the site's own
 *     GetAuctionImage gallery;
 *   - the facts a buyer actually wants — plot area, covered area, build year
 *     (usually stated as an age: "about 38 years old"), floors, planning zone,
 *     bedrooms and bathrooms — extracted by lib/property-facts.mjs.
 *
 * Output is src/data/eauction-details.json, keyed by auction code, which
 * scrape-eauction.mjs merges into each listing, plus deduplicated photo assets
 * under public/eauction-photos/.
 *
 * Access: the site sits behind Imperva. The ad list comes from the unprotected
 * XHR endpoint; the detail pages and attachments do not, so a stealth browser
 * clears the challenge once and every download is made same-origin from that
 * cleared page. Deliberately serial and slow — parallel workers are what
 * triggered an Imperva IP block the last time.
 *
 * Env:
 *   EAUCTION_HARVEST_LIMIT  cap ads processed this run (default: all)
 *   EAUCTION_REHARVEST=1    re-read ads already in the cache (default: only new
 *                           ads, changed auction dates, stale or old-schema entries)
 *   EAUCTION_MAX_AGE_DAYS   re-read a cached ad older than this (default 45)
 *   EAUCTION_SUBTYPES       comma-separated subtype ids (default: all 11)
 *   EAUCTION_STATUSES       comma-separated status ids (default: biddable 3,5,6,7)
 *   EAUCTION_MAX_PHOTOS     photos kept per ad (default 12)
 *   EAUCTION_PRUNE=0        keep cache entries / photo files for ads that are gone
 *   EAUCTION_DELAY_MS       pause between ads (default 1500)
 *   EAUCTION_CODES          comma-separated auction codes to harvest (repair/debug)
 */
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readDocument } from './lib/documents.mjs';
import { extractFacts, mergeFacts } from './lib/property-facts.mjs';

chromium.use(stealth());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const cachePath = path.join(root, 'src/data/eauction-details.json');
const photoDir = path.join(root, 'public/eauction-photos');

const BASE = 'https://www.eauction-cy.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SCHEMA = 4; // bump to force a full re-harvest of every cached entry
const LIMIT = process.env.EAUCTION_HARVEST_LIMIT ? Number(process.env.EAUCTION_HARVEST_LIMIT) : Infinity;
const REHARVEST = process.env.EAUCTION_REHARVEST === '1';
const MAX_AGE_DAYS = Number(process.env.EAUCTION_MAX_AGE_DAYS ?? 45);
const MAX_PHOTOS = Number(process.env.EAUCTION_MAX_PHOTOS ?? 12);
const PRUNE = process.env.EAUCTION_PRUNE !== '0';
const DELAY_MS = Number(process.env.EAUCTION_DELAY_MS ?? 1500);
const IMAGE_TIMEOUT_MS = 2000;   // per embedded image, when pdf.js never delivers it
const MAX_XOBJECTS = 60;         // images inspected per PDF
const AD_PARSE_BUDGET_MS = 60_000; // spent parsing one ad's attachments

// Every property subtype the portal sells (id -> label from its own dropdown).
const SUBTYPES = {
  5: 'Residence', 6: 'Other Commercial Property', 7: 'Store', 8: 'Office',
  9: 'Parking', 10: 'Warehouse', 11: 'Industrial Building', 12: 'Plot',
  13: 'Plot with building', 14: 'Land', 15: 'Land with building',
};
// Auctions you can still act on. 9 (Conducted) and 10 (Cancelled) are the dead
// archive — thousands of lots, no longer advertised, deliberately excluded.
const STATUSES = { 3: 'Posted', 5: 'Finalized List of Eligible Bidders', 6: 'Ready to be Conducted', 7: 'Open' };

const SUBTYPE_IDS = (process.env.EAUCTION_SUBTYPES || Object.keys(SUBTYPES).join(',')).split(',').map(Number);
const STATUS_IDS = (process.env.EAUCTION_STATUSES || Object.keys(STATUSES).join(',')).split(',').map(Number);

const PROPERTY_TYPES = ['ΚΑΤΟΙΚΙΑ', 'ΔΙΑΜΕΡΙΣΜΑ', 'ΟΙΚΟΠΕΔΟ', 'ΧΩΡΑΦΙ', 'ΟΙΚΙΑ', 'ΒΙΛΑ', 'ΚΑΤΑΣΤΗΜΑ', 'ΓΡΑΦΕΙΟ', 'ΑΠΟΘΗΚΗ', 'ΤΕΜΑΧΙΟ', 'ΓΗ', 'ΜΕΖΟΝΕΤΑ'];
const TYPE_EN = {
  ΚΑΤΟΙΚΙΑ: 'Residence', ΔΙΑΜΕΡΙΣΜΑ: 'Apartment', ΟΙΚΟΠΕΔΟ: 'Building plot',
  ΧΩΡΑΦΙ: 'Field', ΟΙΚΙΑ: 'House', ΒΙΛΑ: 'Villa', ΚΑΤΑΣΤΗΜΑ: 'Shop',
  ΓΡΑΦΕΙΟ: 'Office', ΑΠΟΘΗΚΗ: 'Warehouse', ΤΕΜΑΧΙΟ: 'Parcel', ΓΗ: 'Land', ΜΕΖΟΝΕΤΑ: 'Maisonette',
};

// ---- Ad list (unprotected XHR endpoint) ------------------------------------

function listBody(pageNumber, statusId, subTypeId) {
  return JSON.stringify({
    auctionDateFrom: '', auctionDateTo: '', auctionCreationDateFrom: '', auctionCreationDateTo: '',
    offerValueFrom: '', offerValueTo: '', hastenerName: '', auctionCode: '',
    AuctionStatusId: statusId, sortAscending: 'true', sortingFieldId: '1',
    pageNumber: String(pageNumber), AuctionSubTypeId: String(subTypeId),
    extendedFilter1: '', extendedFilter2: '', notApprovedForeignBidderId: '', selectedCountryNumericCode: '0',
    lang: 'en-US',
  });
}

function parseCard(block) {
  const m = re => (block.match(re) || [])[1] || null;
  const code = m(/Unique Code<\/span>[\s\S]*?AList-BoxTextBlue500">\s*([A-Z0-9-]+)/);
  if (!code) return null;
  return {
    code,
    link: m(/AList-BoxFooterMore"\s+href="([^"]+)"/),
    status: m(/AList-BoxheaderLeft[\s\S]*?AList-BoxTextBlueBold">\s*([^<]+?)\s*</),
    auctionDate: m(/DateIcon">\s*(\d{2}\/\d{2}\/\d{4})/),
    posted: m(/Date of Posting<\/span>[\s\S]*?AList-BoxTextBlue500">\s*(\d{2}\/\d{2}\/\d{4})/),
    objectType: m(/Object to be auctioned:\s*([^<]+)/)?.trim() || null,
  };
}

/** Every currently advertised ad, across all requested subtypes and statuses. */
async function listAllAds() {
  const ads = new Map();
  for (const subTypeId of SUBTYPE_IDS) {
    for (const statusId of STATUS_IDS) {
      for (let p = 1; p <= 40; p++) {
        let res;
        try {
          res = await fetch(`${BASE}/Home/HomeListAuctions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'User-Agent': UA,
              'X-Requested-With': 'XMLHttpRequest',
              Referer: `${BASE}/en/Home/HlektronikoiPleistiriasmoi?type=${subTypeId}`,
            },
            body: listBody(p, statusId, subTypeId),
          });
        } catch { break; }
        if (!res.ok) break;
        const blocks = (await res.text()).split(/AList-BoxContainer/).slice(1);
        if (!blocks.length) break;
        let added = 0;
        for (const b of blocks) {
          const card = parseCard(b);
          if (!card || ads.has(card.code)) continue;
          ads.set(card.code, { ...card, subTypeId, subType: SUBTYPES[subTypeId] || String(subTypeId) });
          added++;
        }
        if (blocks.length < 20 || added === 0) break;
        await new Promise(r => setTimeout(r, 400));
      }
    }
  }
  return [...ads.values()];
}

// ---- PDF ------------------------------------------------------------------

/**
 * Text, the FR.08 property table, and candidate photos from one PDF.
 *
 * Image extraction is budgeted. Scanned notices can hold dozens of XObjects
 * whose data never arrives from pdf.js, and each one then costs a full timeout —
 * one such ad took 140 s of a run that averages 4 s. Since the Greek and English
 * copies of an appendix carry the same photos anyway, stopping once we have
 * enough costs nothing.
 */
async function parsePdf(buffer, { maxImages = Infinity, deadline = Infinity } = {}) {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const rows = [];
  const photos = [];
  let text = '';
  let scanned = 0;

  for (let pn = 1; pn <= doc.numPages; pn++) {
    const page = await doc.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(i => i.str.trim())
      .map(i => ({ s: i.str.trim(), x: Math.round(i.transform[4]), y: Math.round(vp.height - i.transform[5]) }));
    text += items.map(i => i.s).join(' ') + '\n';

    // The legal table's columns are located by their header labels — a flat
    // text join mixes the two fraction columns (share vs registration) up.
    const headerX = needle => { const h = items.find(i => i.s.includes(needle)); return h ? h.x : null; };
    const regX = headerX('Εγγραφή');
    const areaX = headerX('Έκταση');
    const shareX = headerX('συμφέρον') ?? headerX('Εγγεγραμμένο');
    const typeX = headerX('Είδος');
    const near = (rowItems, cx, tol = 40) => cx == null ? [] : rowItems.filter(i => Math.abs(i.x - cx) <= tol).map(i => i.s);

    const rowMarkers = items.filter(i => i.x < 36 && /^\d+\.\*{0,4}$/.test(i.s));
    for (const rm of rowMarkers) {
      const rowItems = items.filter(i => Math.abs(i.y - rm.y) < 22).sort((a, b) => a.x - b.x);
      const reg = near(rowItems, regX, 45).find(s => /^\d+\/\d+$/.test(s)) || null;
      const shareCell = near(rowItems, shareX, 40).find(s => {
        const mm = s.match(/^(\d{1,4})\/(\d{1,5})$/);
        return mm && Number(mm[1]) > 0 && Number(mm[1]) <= Number(mm[2]);
      }) || null;
      // The Έκταση cell is often a dash (the extent lives only in the deed), and
      // pdf.js shreds nearby text into single characters — so require at least
      // two digits rather than accepting a stray "4" as a 4 m² plot.
      const areaTok = near(rowItems, areaX ?? -999, 40)
        .map(s => s.replace(/\./g, '').replace(',', '.'))
        .find(s => /^\d{2,7}(?:\.\d+)?$/.test(s) && !/\//.test(s));
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

    if (photos.length >= maxImages || Date.now() > deadline) continue; // text only from here on
    const ops = await page.getOperatorList();
    const seen = new Set();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (photos.length >= maxImages || scanned >= MAX_XOBJECTS || Date.now() > deadline) break;
      const fn = ops.fnArray[i];
      if (fn !== OPS.paintImageXObject && fn !== OPS.paintJpegXObject) continue;
      const name = ops.argsArray[i][0];
      if (typeof name !== 'string' || seen.has(name)) continue;
      seen.add(name);
      scanned++;
      const img = await getPdfImage(page, name);
      if (!img || !img.data) continue;
      const rgba = toRgba(img);
      const stat = analyze(rgba, img.width, img.height);
      if (isPhoto(stat, img.width, img.height)) photos.push({ rgba, width: img.width, height: img.height });
    }
  }
  return { rows, photos, text };
}

function getPdfImage(page, name) {
  return new Promise(res => {
    let done = false;
    const cb = o => { if (!done) { done = true; res(o); } };
    setTimeout(() => cb(null), IMAGE_TIMEOUT_MS);
    try { page.objs.get(name, cb); } catch { cb(null); }
  });
}

function toRgba(img) {
  const { width: w, height: h, kind, data } = img;
  if (kind === 3) return data;
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (kind === 2) {
    for (let p = 0; p < w * h; p++) { rgba[p * 4] = data[p * 3]; rgba[p * 4 + 1] = data[p * 3 + 1]; rgba[p * 4 + 2] = data[p * 3 + 2]; rgba[p * 4 + 3] = 255; }
  } else {
    for (let p = 0; p < w * h; p++) { const v = data[p] || 0; rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255; }
  }
  return rgba;
}

/**
 * Property photo or land-registry map? Maps and the form banner are grey
 * line-art on white (saturation ~3-4, white fraction ~0.8); photos are
 * saturated and dark (saturation 28-46, white <= 0.27).
 */
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

const isPhoto = (stat, w, h) => stat.sat >= 12 && stat.white <= 0.5 && w >= 200 && h >= 200;

/** Same discriminator for an already-encoded image (Word/RTF media). */
async function isPhotoEncoded(buf) {
  try {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return isPhoto(analyze(data, info.width, info.height), info.width, info.height);
  } catch {
    return false;
  }
}

// ---- Photo storage ---------------------------------------------------------

/**
 * Photos are stored under a content hash, not the auction code: a multi-lot
 * auction repeats the same appendix for every lot, and the same property comes
 * back under a new code when an auction is re-posted. Hashing collapses both.
 */
async function savePhoto(jpeg) {
  const hash = createHash('sha1').update(jpeg).digest('hex').slice(0, 12);
  const file = path.join(photoDir, `${hash}.jpg`);
  if (!existsSync(file)) writeFileSync(file, jpeg);
  return `/eauction-photos/${hash}.jpg`;
}

const toJpeg = input => sharp(input)
  .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 82 })
  .toBuffer();

// ---- Detail page -----------------------------------------------------------

/** Read the detail page's label/value grid, attachment links and gallery images. */
async function readDetailPage(page) {
  return page.evaluate(() => {
    const fields = {};
    for (const div of document.querySelectorAll('.AuctionDetailsDiv, .AuctionDetailsDivR, .AuctionDetailsDivRight, .AuctionDetailsDiv2')) {
      const labels = [...div.querySelectorAll('label')];
      if (labels.length < 2) continue;
      const key = (labels[0].textContent || '').replace(/\s+/g, ' ').trim();
      const value = (labels[labels.length - 1].textContent || '').replace(/[ \t]+/g, ' ').trim();
      if (key && value && !(key in fields)) fields[key] = value;
    }
    const statusBox = document.querySelector('.StateValue');
    if (statusBox) fields.Status = statusBox.textContent.trim();

    const docs = [...new Set([...document.querySelectorAll('a')]
      .filter(a => /GetFile/i.test(a.href))
      .map(a => JSON.stringify({ href: a.href, name: (a.textContent || '').trim() })))].map(s => JSON.parse(s));

    // The site's own gallery: thumbnails in the DOM, full size behind the same
    // token with thumb=false.
    const gallery = [...new Set([
      ...[...document.querySelectorAll('img')].map(i => i.src),
      ...[...document.querySelectorAll('a')].map(a => a.href),
    ].filter(u => /GetAuctionImage/i.test(u)))].map(u => u.replace(/thumb=true/i, 'thumb=false'));

    return { fields, docs, gallery };
  });
}

/** Download an attachment from inside the challenge-cleared page. */
async function fetchAttachment(page, url) {
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(u);
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = ''; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }, url);
  return b64 ? Buffer.from(b64, 'base64') : null;
}

// ---- Field helpers ---------------------------------------------------------

const intOrNull = s => {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Nothing auctioned here is smaller than a parking space; below that it's a parse artefact. */
const area = v => (Number.isFinite(v) && v >= 10 && v <= 2_000_000 ? Math.round(v) : null);

const yearOf = dmy => {
  const m = /(\d{2})[/\-.](\d{2})[/\-.](\d{4})/.exec(dmy || '');
  return m ? Number(m[3]) : null;
};

// ---- Harvest ---------------------------------------------------------------

function saveCache(cache) {
  writeFileSync(cachePath, JSON.stringify(cache, null, 1), 'utf-8');
}

function needsHarvest(cached, ad) {
  if (REHARVEST || !cached) return true;
  if (cached.v !== SCHEMA) return true;                       // schema changed
  if (ad.auctionDate && cached.auctionDate !== ad.auctionDate) return true; // re-posted
  // An entry with nothing in it came from a bad read, not from a bare ad —
  // every real ad publishes at least a property type. Retry it next run.
  if (!cached.propertyType && !(cached.docs || []).length) return true;
  if (!cached.harvestedAt) return true;
  const ageDays = (Date.now() - Date.parse(cached.harvestedAt)) / 86400000;
  return !(ageDays < MAX_AGE_DAYS);
}

export async function harvestEauction() {
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf-8')) : {};
  mkdirSync(photoDir, { recursive: true });

  console.error(`Listing ads (subtypes ${SUBTYPE_IDS.join(',')} / statuses ${STATUS_IDS.join(',')})...`);
  const ads = (await listAllAds()).filter(a => a.link && /\/Auction\/Details\//.test(a.link));
  const byType = {};
  for (const a of ads) byType[a.subType] = (byType[a.subType] || 0) + 1;
  console.error(`${ads.length} advertised ads: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  const only = (process.env.EAUCTION_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
  const stale = ads
    .filter(a => (only.length ? only.includes(a.code) : true))
    .filter(a => needsHarvest(cache[a.code], a));
  const todo = stale.slice(0, LIMIT);
  console.error(`${todo.length} to harvest (${ads.length - stale.length} already cached and current${stale.length > todo.length ? `, ${stale.length - todo.length} deferred by EAUCTION_HARVEST_LIMIT` : ''}).`);

  const stats = { ok: 0, photos: 0, withPhotos: 0, facts: 0, year: 0, house: 0, plot: 0, docs: 0, kinds: {}, errors: 0 };

  if (todo.length) {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 }, locale: 'el-GR' });
    const page = await ctx.newPage();

    // Clear the Imperva challenge once; every later navigation reuses it.
    await page.goto(`${BASE}/en/Home/HlektronikoiPleistiriasmoi?type=5`, { waitUntil: 'domcontentloaded' });
    let cleared = false;
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1500);
      if (!/please wait|just a moment/i.test(await page.title())) { cleared = true; break; }
    }
    if (!cleared) {
      await browser.close();
      console.error('Imperva challenge never cleared — this IP is blocked or the wall changed. Nothing harvested.');
      return { ads: ads.length, todo: todo.length, ...stats, blocked: 'challenge' };
    }

    let done = 0;
    let consecutiveFailures = 0;
    for (const ad of todo) {
      // An Imperva IP block hits everything at once, and retrying lengthens the
      // cooldown. Stop early and keep what we have rather than spending an hour
      // collecting 403s.
      if (consecutiveFailures >= 8) {
        console.error('::warning::8 consecutive failures — assuming an IP block and stopping early. Cache keeps what was harvested.');
        break;
      }
      const code = ad.code;
      const t0 = Date.now();
      let tNav = 0;
      try {
        await page.goto(ad.link, { waitUntil: 'domcontentloaded' });
        tNav = Date.now() - t0;
        // Once the challenge is cleared the session carries it, so detail pages
        // normally load straight away — check before sleeping, or 400 ads pay a
        // wait none of them needs.
        let challenged = /please wait|just a moment/i.test(await page.title());
        for (let i = 0; challenged && i < 15; i++) {
          await page.waitForTimeout(1200);
          challenged = /please wait|just a moment/i.test(await page.title());
        }
        // The detail grid, the attachment links and the gallery are all painted
        // together by client-side script about 2 s after navigation. Waiting for
        // the grid rather than sleeping a fixed interval is both faster and
        // safer: a short sleep silently yields an ad with no fields and no
        // documents, which looks exactly like an ad that has none.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await page.waitForFunction(
              () => document.querySelectorAll('.AuctionDetailsDiv, .AuctionDetailsDivR, .AuctionDetailsDivRight').length >= 3,
              null, { timeout: 12000 },
            );
            break;
          } catch { await page.waitForTimeout(800); } // context destroyed by a redirect, or a slow render
        }
        await page.waitForTimeout(300);

        let detail = null;
        for (let attempt = 0; attempt < 2 && !detail; attempt++) {
          try { detail = await readDetailPage(page); }
          catch { await page.waitForTimeout(1500); } // context destroyed by a redirect
        }
        if (!detail) {
          console.error(`  ${code}: detail page unreadable`);
          stats.errors++;
          consecutiveFailures++;
          continue;
        }

        // A render that never completed looks exactly like an ad with no fields
        // and no documents — and writing that would blank a good cache entry on
        // a transient hiccup. Treat it as a failure and keep what we already had.
        if (Object.keys(detail.fields).length < 3) {
          console.error(`  ${code}: detail grid never rendered — skipped, cached entry kept`);
          stats.errors++;
          consecutiveFailures++;
          continue;
        }

        const f = detail.fields;
        const docDate = f['Notification Date'] || f['Date of Posting'] || ad.auctionDate;
        const referenceYear = yearOf(docDate) || yearOf(ad.auctionDate) || new Date().getUTCFullYear();

        // --- attachments: PDFs, Word, RTF, bare images -----------------------
        const rows = [];
        const rawPhotos = [];      // { rgba, width, height } from PDFs
        const encodedPhotos = [];  // already-encoded bytes from Word/RTF/images
        const docTexts = [];
        const docList = [];
        const parseDeadline = Date.now() + AD_PARSE_BUDGET_MS;
        for (const d of detail.docs) {
          const buf = await fetchAttachment(page, d.href);
          if (!buf || buf.length < 64) { docList.push({ name: d.name, kind: 'unavailable' }); continue; }
          stats.docs++;
          if (buf.subarray(0, 4).toString('latin1') === '%PDF') {
            docList.push({ name: d.name, kind: 'pdf' });
            stats.kinds.pdf = (stats.kinds.pdf || 0) + 1;
            try {
              const parsed = await parsePdf(buf, {
                maxImages: Math.max(0, MAX_PHOTOS - rawPhotos.length),
                deadline: parseDeadline,
              });
              rows.push(...parsed.rows);
              rawPhotos.push(...parsed.photos);
              docTexts.push({ name: d.name, text: parsed.text });
            } catch (err) { console.error(`  ${code}: PDF parse failed (${d.name}): ${err.message}`); }
            continue;
          }
          // Word / RTF / image attachment.
          const read = readDocument(buf);
          docList.push({ name: d.name, kind: read.kind });
          stats.kinds[read.kind] = (stats.kinds[read.kind] || 0) + 1;
          if (read.text) docTexts.push({ name: d.name, text: read.text });
          for (const img of read.images) encodedPhotos.push(img.data);
          if (read.kind === 'doc') console.error(`  ${code}: legacy .doc read as text only (${d.name})`);
          if (read.kind === 'unknown') console.error(`  ${code}: unrecognised attachment ${d.name}`);
        }

        // --- photos ----------------------------------------------------------
        // "Additional information" sheets carry the property shots; the legal
        // notice carries maps. Order is preserved so the first photo is the
        // best available.
        // Greek and English copies of the same sheet embed the same photos, and
        // content hashing lands them on the same file — so dedupe by path.
        const seenImages = new Set();
        const images = [];
        const addImage = u => { if (u && !seenImages.has(u)) { seenImages.add(u); images.push(u); } };
        detail.gallery.forEach(addImage);
        let stored = 0;
        for (const p of rawPhotos) {
          if (stored >= MAX_PHOTOS) break;
          const jpeg = await sharp(Buffer.from(p.rgba), { raw: { width: p.width, height: p.height, channels: 4 } })
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 82 })
            .toBuffer()
            .catch(() => null);
          if (!jpeg) continue;
          const before = images.length;
          addImage(await savePhoto(jpeg));
          if (images.length > before) stored++;
        }
        for (const buf of encodedPhotos) {
          if (stored >= MAX_PHOTOS) break;
          if (!(await isPhotoEncoded(buf))) continue;
          const jpeg = await toJpeg(buf).catch(() => null);
          if (!jpeg) continue;
          const before = images.length;
          addImage(await savePhoto(jpeg));
          if (images.length > before) stored++;
        }

        // --- facts -----------------------------------------------------------
        // Trust order: the "additional information" sheet (a valuer's field
        // report) beats the legal notice, which beats the detail page's own
        // free text.
        const isInfoSheet = n => /additional information|πρόσθετες πληροφορίες/i.test(n || '');
        const infoText = docTexts.filter(d => isInfoSheet(d.name)).map(d => d.text).join('\n');
        const noticeText = docTexts.filter(d => !isInfoSheet(d.name)).map(d => d.text).join('\n');
        const pageText = [f["Property's other details"], f['Property details'], f.Remarks].filter(Boolean).join('\n');

        const facts = mergeFacts(
          extractFacts(infoText, { referenceYear }),
          extractFacts(noticeText, { referenceYear }),
          extractFacts(pageText, { referenceYear }),
        );

        // This code's lot in a multi-lot notice: suffix -00N -> table row N.
        const suffix = (code.match(/-(\d+)$/) || [])[1];
        const row = rows.find(r => r.idx === Number(suffix || 1)) || rows[0] || null;

        // "Area sq.m." on the detail page is Έκταση from the land registry —
        // the *extent of the registered parcel*, i.e. the plot, even when the
        // lot is a house. It is only a floor area when the registration is a
        // unit inside a building (apartment, office, shop, parking), which have
        // no plot of their own.
        const registeredArea = intOrNull(f['Area sq.m.']) ?? row?.areaSqm ?? null;
        const typeText = `${ad.subType} ${f['Real Estate Type'] || ''} ${row?.propertyTypeGr || ''} ${row?.propertyType || ''}`;
        // A "Residence" can still be registered as a unit in a co-owned building
        // — "ΔΙΩΡΟΦΗ ΚΑΤΟΙΚΙΑ ΑΡ. 2 ΣΤΟ ΙΣΟΓΕΙΟ" with a share of the common
        // property. Its registered extent is then the unit's floor area, not
        // land, so the property text has to be consulted as well as the type.
        const unitMarkers = /ΕΜΒΑΔΟ\s+ΜΟΝΑΔΑΣ|ΚΟΙΝΟΚΤΗΤΗ\s+ΙΔΙΟΚΤΗΣΙΑ|κοιν[όο]κτητ|ΑΡ\.\s*\d+\s+ΣΤΟ\s+(?:ΙΣΟΓΕΙΟ|[ΟΌ]ΡΟΦΟ)/i;
        const isUnit = /Apartment|Flat|Office|Store|Shop|Parking|ΔΙΑΜΕΡΙΣΜΑ|ΓΡΑΦΕΙΟ|ΚΑΤΑΣΤΗΜΑ/i.test(typeText)
          || unitMarkers.test(f["Property's other details"] || '');

        const entry = {
          v: SCHEMA,
          harvestedAt: new Date().toISOString().slice(0, 10),
          subType: ad.subType,
          subTypeId: ad.subTypeId,
          status: f.Status || ad.status || null,
          auctionDate: ad.auctionDate || null,
          propertyType: f['Real Estate Type'] || row?.propertyType || null,
          registration: f['Registration Number'] || row?.reg || null,
          sheetPlanPlot: f['Sheet / Plan, Plot'] || null,
          address: f.Address || null,
          share: f['Registered share or interest'] || row?.share || null,
          lender: f["Mortgage Lender's Name"] || null,
          guarantee: intOrNull(f['Guarantee Amount']),
          notificationDate: f['Notification Date'] || null,
          // The valuer's own "Land area" / "Building area" win when present:
          // they say what they measure. The registry extent is the fallback, and
          // which field it belongs in depends on whether the lot is a unit.
          plotSqm: area(facts.plotSqm ?? (isUnit ? null : registeredArea)),
          houseSqm: area(facts.houseSqm ?? (isUnit ? registeredArea : null)),
          buildYear: facts.buildYear ?? null,
          buildYearSource: facts.buildYearSource ?? null,
          beds: facts.beds ?? null,
          baths: facts.baths ?? null,
          floors: facts.floors ?? null,
          verandaSqm: facts.verandaSqm ?? null,
          planningZone: facts.planningZone ?? null,
          maxDensityPct: facts.maxDensityPct ?? null,
          maxCoveragePct: facts.maxCoveragePct ?? null,
          maxHeightM: facts.maxHeightM ?? null,
          docs: docList,
          image: images[0] ?? null,
          images: images.length ? images : null,
        };
        for (const k of Object.keys(entry)) if (entry[k] == null) delete entry[k];
        cache[code] = entry;

        stats.ok++;
        consecutiveFailures = 0;
        stats.photos += stored;
        if (images.length) stats.withPhotos++;
        if (entry.buildYear) stats.year++;
        if (entry.houseSqm) stats.house++;
        if (entry.plotSqm) stats.plot++;
        if (Object.keys(facts).length) stats.facts++;
        console.error(`  ${code} [${ad.subType}] ${images.length} img, plot=${entry.plotSqm ?? '-'}, house=${entry.houseSqm ?? '-'}, year=${entry.buildYear ?? '-'}, beds=${entry.beds ?? '-'}, docs=${docList.length} (${Date.now() - t0}ms, nav ${tNav}ms)`);
      } catch (err) {
        stats.errors++;
        consecutiveFailures++;
        console.error(`  ${code}: ERROR ${err.message}`);
      }

      done++;
      await page.waitForTimeout(DELAY_MS);
      if (done % 25 === 0) {
        // Checkpoint: a cold harvest is a ~40-minute run against a site that can
        // cut us off at any point. Writing only at the end means an interruption
        // throws away everything already fetched.
        saveCache(cache);
        console.error(`  … ${done}/${todo.length} (${stats.ok} ok, ${stats.errors} failed); checkpointed, pausing to stay under the rate limit`);
        await page.waitForTimeout(8000);
      }
    }
    await browser.close();
  }

  // Every ad failing is not "nothing to do" — it is the site refusing this IP,
  // which is what a datacenter runner gets. Report it as such and leave the
  // cache (and its photos) exactly as they were, pruning included.
  const blocked = todo.length > 0 && stats.ok === 0 ? 'refused' : null;
  if (blocked) {
    console.error(`\nAll ${todo.length} ads failed to render — this IP is being refused. Cache left untouched.`);
    return { ads: ads.length, todo: todo.length, ...stats, blocked };
  }

  // --- prune ads that are no longer advertised -------------------------------
  if (PRUNE) {
    const live = new Set(ads.map(a => a.code));
    let dropped = 0;
    for (const code of Object.keys(cache)) {
      if (!live.has(code)) { delete cache[code]; dropped++; }
    }
    const referenced = new Set();
    for (const e of Object.values(cache)) {
      for (const img of e.images || []) if (img.startsWith('/eauction-photos/')) referenced.add(path.basename(img));
    }
    let removedFiles = 0;
    for (const file of readdirSync(photoDir)) {
      if (!referenced.has(file)) { unlinkSync(path.join(photoDir, file)); removedFiles++; }
    }
    if (dropped || removedFiles) console.error(`Pruned ${dropped} finished ad(s) and ${removedFiles} orphan photo file(s).`);
  }

  saveCache(cache);
  const kinds = Object.entries(stats.kinds).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  console.error(
    `\nHarvested ${stats.ok}/${todo.length} ads (${stats.errors} errors). ` +
    `Photos: ${stats.photos} new files, ${stats.withPhotos} ads with images. ` +
    `Facts: ${stats.plot} plot area, ${stats.house} covered area, ${stats.year} build year. ` +
    `Attachments read: ${stats.docs} (${kinds}). Cache now ${Object.keys(cache).length} ads → ${cachePath}`
  );
  return { ads: ads.length, todo: todo.length, ...stats, blocked: null };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await harvestEauction();
  // 3 = the site refused this IP. Callers (the workflow) treat it as "nothing
  // to do here", distinct from a crash, which still exits non-zero the usual way.
  process.exit(result.blocked ? 3 : 0);
}
