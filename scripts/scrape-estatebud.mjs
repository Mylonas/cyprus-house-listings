#!/usr/bin/env node
/**
 * scrape-estatebud.mjs
 * Generic scraper for Cyprus agency sites built on the EstateBud platform that
 * render listings client-side under a per-agency theme (the "URL mode" variant,
 * e.g. Kazo). Unlike the WordPress-admin-ajax variant (Kadis, which has its own
 * scraper), these have no clean JSON endpoint and each theme uses different card
 * markup — so we render the page in a browser and extract cards by a structural
 * anchor common to every EstateBud theme: each card is the smallest element that
 * wraps exactly one `estbd.io/<account>/<id>/…` image together with a
 * `/propert…/<slug>-<id>` detail link. Price / area / beds are read from the
 * card's text.
 *
 * Add an agency by appending to AGENCIES (source name + the rendered for-sale
 * list URL that paginates with &p=N). Houses and plots differ only by the
 * category/type query params baked into that URL.
 *
 * Env:
 *   ESTATEBUD_PAGES - max pages to walk per agency (default 250; the loop
 *                     stops early once the pager runs out, so this is just a
 *                     safety cap — 250 covers Kazo's full ~240-page inventory)
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const PAGES = Number(process.env.ESTATEBUD_PAGES ?? 250);
// Per-agency wall-clock cap for the SPA walk (default 12 min, comfortably under
// the aggregators' 15-min per-source hard timeout).
const WALK_BUDGET_MS = Number(process.env.ESTATEBUD_WALK_BUDGET_MS ?? 12 * 60 * 1000);

// Each agency: a rendered EstateBud list URL. `kind` picks the output schema.
export const AGENCIES = [
  {
    source: 'Kazo Real Estate',
    kind: 'house',
    base: 'https://kazo.com.cy/real-estate?category=residential&main_category=sale&type=residential_&area_1[]=CY',
  },
  {
    source: 'Kazo Real Estate',
    kind: 'plot',
    base: 'https://kazo.com.cy/real-estate?category=land&main_category=sale&area_1[]=CY',
  },
  {
    // Cyprus Properties (A. Chrysostomou) — a different EstateBud theme:
    // detail links are /property/<id>, price is written "1,234,000€". Its
    // for-sale grid mixes buildings and land, so the house pass keeps only
    // items with a bedroom count and the plot pass uses the ?type=land filter.
    source: 'Cyprus Properties',
    kind: 'house',
    base: 'https://www.cyprusproperties.com.cy/properties',
    filter: item => item.beds != null,
  },
  {
    source: 'Cyprus Properties',
    kind: 'plot',
    base: 'https://www.cyprusproperties.com.cy/properties?type=land',
  },
];

const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];
const AREA_DISTRICT = {
  Germasoyeia: 'Limassol', Germasogeia: 'Limassol', Neapolis: 'Limassol', Mesa: 'Limassol',
  Strovolos: 'Nicosia', Lakatameia: 'Nicosia', Latsia: 'Nicosia', Aglantzia: 'Nicosia', Engomi: 'Nicosia',
  Paralimni: 'Famagusta', Deryneia: 'Famagusta',
};
function districtFrom(loc) {
  const s = loc || '';
  for (const d of DISTRICTS) if (new RegExp(`\\b${d}\\b`, 'i').test(s)) return d;
  for (const [a, d] of Object.entries(AREA_DISTRICT)) if (new RegExp(`\\b${a}`, 'i').test(s)) return d;
  return (s.split(',').pop() || '').trim() || null;
}
function plotTypeFromTitle(t) {
  const s = (t || '').toLowerCase();
  for (const kw of ['residential', 'commercial', 'agricultural', 'industrial', 'tourist']) if (s.includes(kw)) return kw[0].toUpperCase() + kw.slice(1);
  if (/\bfield\b/.test(s)) return 'Agricultural';
  return null;
}

// Runs in the page: extract cards by the EstateBud structural anchor.
function extractCards() {
  const out = [];
  const seen = new Set();
  for (const img of document.querySelectorAll('img[src*="estbd.io"]')) {
    const m = img.src.match(/estbd\.io\/[^/]+\/(\d+)\//);
    if (!m) continue;
    const id = m[1];
    // Smallest ancestor holding this one image and a property detail link.
    let el = img, card = null;
    for (let i = 0; i < 8 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const a = el.querySelector('a[href*="/propert"]');
      const imgs = el.querySelectorAll('img[src*="estbd.io"]').length;
      if (a && imgs === 1) { card = el; break; }
    }
    if (!card) continue;
    const linkEl = card.querySelector('a[href*="/propert"]');
    const link = linkEl ? linkEl.href : null;
    if (!link || seen.has(id)) continue;
    seen.add(id);
    const txt = (card.innerText || '').replace(/\s+/g, ' ').trim();
    const images = [...new Set([...card.querySelectorAll('img[src*="estbd.io"]')].map(i => i.src))];
    // Title: prefer the anchor's own text/title; some themes carry no slug in
    // the link (…/property/<id>) and put the name in a heading instead.
    const headingEl = card.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="name" i]');
    const title = (linkEl.getAttribute('title') || linkEl.innerText || (headingEl ? headingEl.textContent : ''))
      .replace(/\s+/g, ' ').trim() || null;
    out.push({ id, link, txt, title, images });
  }
  return out;
}

function parseCard(c, kind, source) {
  const txt = c.txt || '';
  // Price appears as either "€70,000" (symbol first) or "3,995,000€" (symbol
  // last, sometimes "+VAT") depending on the EstateBud theme.
  // Require >=4 digit/separator chars so a bare bed count next to a trailing €
  // ("3,995,000€ 5 …") is never mistaken for the price.
  const priceM = txt.match(/€\s?(\d[\d.,]{3,})/) || txt.match(/(\d[\d.,]{3,})\s?€/);
  const price = priceM ? Number(priceM[1].replace(/[.,]/g, '')) : null;
  // Area is written "93 m²" or "272sqm"/"272 m2" across themes.
  const areaM = txt.match(/([\d.,]+)\s*(?:m²|m2|sqm)/i);
  const area = areaM ? Math.round(Number(areaM[1].replace(/[.,]/g, ''))) : null;
  // Beds/baths: labelled ("3 Beds 2 Baths") on some themes; on others they are
  // two bare integers sitting between the price and the area ("… € 5 5 272sqm").
  let beds = (txt.match(/(\d+)\s*(?:Beds?|bed)/i) || [])[1];
  let baths = (txt.match(/(\d+)\s*(?:Baths?|bath)/i) || [])[1];
  if (beds == null && baths == null) {
    const posM = txt.match(/€\s*(\d+)\s+(\d+)\s+[\d.,]+\s*(?:m²|m2|sqm)/i);
    if (posM) { beds = posM[1]; baths = posM[2]; }
  }
  // Title from the detail-link slug (…-<id>) if neither anchor nor heading had one.
  let title = c.title;
  if (!title) {
    const slug = (c.link.match(/\/([a-z0-9-]+?)-\d+\/?$/i) || [])[1];
    title = slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()) : (kind === 'plot' ? 'Plot for sale' : 'Property for sale');
  }
  // Location: the district word in the card text (stop before any beds/area).
  const locM = txt.match(/\b(Nicosia|Limassol|Larnaca|Larnaka|Paphos|Pafos|Famagusta)\b/i);
  const location = locM ? locM[1] : districtFrom(title);

  const base = {
    source, title,
    price,
    priceDisplay: price ? `€${price.toLocaleString('en-US')}` : null,
    location,
    district: districtFrom(location || title),
    image: c.images[0] || null,
    images: c.images,
    link: c.link,
    beds: beds ? Number(beds) : null,
    baths: baths ? Number(baths) : null,
    posted: null, postedTs: null, buildYear: null,
    ref: c.id,
  };
  if (kind === 'plot') {
    return { ...base, kind: 'plot', houseSqm: null, plotSqm: area, plotType: plotTypeFromTitle(title), zone: null };
  }
  return { ...base, houseSqm: area, plotSqm: null };
}

// The URL-mode EstateBud sites are SPAs: the ?p= param is ignored and pages are
// changed by clicking the numbered pager, which swaps the cards in place. We
// load once, extract, then click each next page number and re-extract.
async function scrapeAgency(page, agency) {
  const all = [];
  const seen = new Set();
  try {
    await page.goto(agency.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('img[src*="estbd.io"]', { timeout: 20000 });
    await page.waitForTimeout(1500);
  } catch {
    return all;
  }

  const collect = async () => {
    const cards = await page.evaluate(extractCards);
    let added = 0;
    for (const c of cards) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      added++; // count every distinct card so the pager loop keeps advancing
      const item = parseCard(c, agency.kind, agency.source);
      if (item.price == null) continue; // skip "price on request" listings
      if (agency.filter && !agency.filter(item)) continue; // e.g. drop land from a house pass
      all.push(item);
    }
    return added;
  };

  // Wall-clock budget: return whatever we have well before any outer per-source
  // hard timeout, so a slow deep walk degrades to partial data instead of being
  // discarded entirely.
  const deadline = Date.now() + WALK_BUDGET_MS;

  await collect();
  for (let pg = 2; pg <= PAGES; pg++) {
    if (Date.now() > deadline) break;
    const firstBefore = await page.evaluate(() => (document.querySelector('img[src*="estbd.io"]')?.src.match(/estbd\.io\/[^/]+\/(\d+)\//) || [])[1]);
    // Click the pager element whose visible text is exactly this page number.
    const clicked = await page.evaluate((n) => {
      const el = [...document.querySelectorAll('[class*="pag"] a, [class*="pag"] button, nav a, nav button, li a')]
        .find(e => (e.innerText || '').trim() === String(n));
      if (el) { el.click(); return true; }
      return false;
    }, pg);
    if (!clicked) break; // no such page -> end of results
    // Wait for the card set to change.
    try {
      await page.waitForFunction(
        (prev) => (document.querySelector('img[src*="estbd.io"]')?.src.match(/estbd\.io\/[^/]+\/(\d+)\//) || [])[1] !== prev,
        firstBefore, { timeout: 12000 }
      );
    } catch { break; }
    await page.waitForTimeout(800);
    if ((await collect()) === 0) break;
  }
  return all;
}

export async function scrapeEstateBud(kind = null, sourceName = null) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const all = [];
  for (const agency of AGENCIES) {
    if (kind && agency.kind !== kind) continue;
    if (sourceName && agency.source !== sourceName) continue;
    try {
      const items = await scrapeAgency(page, agency);
      console.error(`  ${agency.source} (${agency.kind}): ${items.length}`);
      all.push(...items);
    } catch (err) {
      console.error(`  ${agency.source} (${agency.kind}) failed: ${err.message}`);
    }
  }
  await browser.close();
  return all;
}

// Houses / plots entry points for the two aggregators.
export const scrapeEstateBudHouses = () => scrapeEstateBud('house');
export const scrapeEstateBudPlots = () => scrapeEstateBud('plot');

// One aggregator source per agency, so each deep SPA walk gets its own
// per-source timeout budget and one slow agency can't sink the others.
export function estateBudSources(kind) {
  const names = [...new Set(AGENCIES.filter(a => a.kind === kind).map(a => a.source))];
  return names.map(name => [`${name}`, () => scrapeEstateBud(kind, name)]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeEstateBud(process.argv[2] || null);
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} EstateBud listings.`);
}
