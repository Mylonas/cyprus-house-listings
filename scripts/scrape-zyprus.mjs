#!/usr/bin/env node
/**
 * scrape-zyprus.mjs
 * Scrapes house listings from zyprus.com's sale search grid (type_top[]=3 = House).
 *
 * Transport: curl, not a browser and not Node's fetch — see lib/curl-fetch.mjs.
 * Zyprus sits behind Cloudflare, which challenges both headless Chromium and
 * undici but passes curl. The old Playwright version returned zero listings for
 * weeks because of this.
 *
 * Cards are parsed out of the server-rendered `<article>` markup with regexes
 * rather than a DOM library — the same approach the retired nicosia-house-prices
 * parser used against these exact selectors, and it avoids a dependency.
 *
 * Env:
 *   ZYPRUS_MAX_PAGES - result pages to walk, ~24 listings/page (default 15)
 */
import { curlFetch, isChallenge } from './lib/curl-fetch.mjs';
import { resolveDistrict } from './lib/districts.mjs';

const MAX_PAGES = Number(process.env.ZYPRUS_MAX_PAGES ?? 15);
const BASE = 'https://www.zyprus.com';

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

function parseCards(html) {
  const out = [];
  for (const part of html.split('<article ').slice(1)) {
    const idm = /about="(\/property\/[^"]+)"[^>]*data-node-id="(\d+)"/.exec(part);
    if (!idm) continue; // non-property article (promo blocks etc.)
    const [, slug, nodeId] = idm;

    const title = decode(/property-details__title[\s\S]*?<a[^>]*>([^<]+)<\/a>/.exec(part)?.[1] ?? '');
    const priceRaw = /property-details__price">\s*[^\d<]*([\d,]+)/.exec(part)?.[1] ?? '';
    const loc = decode(/property-details__location">\s*<h2>\s*([^<]+)/.exec(part)?.[1] ?? '');
    const img = /<img[^>]+src="([^"]+)"/.exec(part)?.[1] ?? null;

    const price = Number(priceRaw.replace(/,/g, '')) || null;
    // "3 Bedroom Detached House For Sale" — the slug repeats it if the title is odd.
    const beds = Number(/(\d+)\s*bedroom/i.exec(`${title} ${slug.replace(/-/g, ' ')}`)?.[1]) || null;

    out.push({
      source: 'Zyprus',
      title: title || null,
      price,
      priceDisplay: price ? `€${price.toLocaleString('en-US')}` : null,
      location: loc || null,
      district: resolveDistrict({ location: loc, title, link: slug }),
      image: img ? (img.startsWith('http') ? img : BASE + img) : null,
      images: img ? [img.startsWith('http') ? img : BASE + img] : [],
      link: BASE + slug,
      houseSqm: null,
      plotSqm: null,
      beds,
      baths: null,
      posted: null,
      postedTs: null,
      buildYear: null,
      newBuild: /New Build/.test(part) || undefined,
      ref: nodeId,
    });
  }
  return out;
}

export async function scrapeZyprus() {
  const all = [];
  const seen = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `${BASE}/search/sale/grid?type_top%5B%5D=3&page=${p}`;
    let html;
    try {
      html = await curlFetch(url);
    } catch (err) {
      console.error(`  Zyprus p${p} fetch failed: ${err.message}`);
      break;
    }
    if (isChallenge(html)) {
      console.error(`  Zyprus p${p} served a Cloudflare challenge — stopping.`);
      break;
    }

    const cards = parseCards(html);
    if (cards.length === 0) break;

    let added = 0;
    for (const c of cards) {
      if (seen.has(c.ref)) continue;
      seen.add(c.ref);
      all.push(c);
      added++;
    }
    // Pages past the end repeat the last page rather than 404ing.
    if (added === 0) break;

    await new Promise((r) => setTimeout(r, 600)); // gentle, mirrors the other scrapers
  }

  return all;
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeZyprus();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Zyprus listings.`);
}
