#!/usr/bin/env node
/**
 * scrape-dom.mjs
 * DOM real estate (dom.com.cy) — the Prime Property Group portal, one of the
 * largest inventories on the island (~30k objects across all categories). The
 * catalog is server-rendered Bitrix with clean pagination:
 *   /en/catalog/sale/type-house/?page=page-N   (20 cards per page)
 * so a plain fetch walks the whole house inventory — no browser needed.
 *
 * Each card is a schema.org/Product block holding the detail link
 * (/en/catalog/sale/<id>/), title ("Villa in Limassol / Potamos Germasogeias"),
 * slider images, Total area / Bedrooms / Plot Size features and a machine-
 * readable price meta. No posted date is published on cards.
 *
 * Env:
 *   DOM_MAX_PAGES - hard page cap (default 400; the walk stops early when a
 *                   page returns no cards)
 */
import { pathToFileURL } from 'node:url';

const MAX_PAGES = Number(process.env.DOM_MAX_PAGES ?? 400);
const ORIGIN = 'https://dom.com.cy';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CONCURRENCY = 5;

const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];

function districtFrom(loc) {
  const s = loc || '';
  for (const d of DISTRICTS) if (new RegExp(`\\b${d}\\b`, 'i').test(s)) return d;
  return null;
}

function parseCards(html) {
  const blocks = html.split('<div class="catalog-item" itemscope').slice(1);
  const out = [];
  for (const b of blocks) {
    const id = (b.match(/href="\/en\/catalog\/sale\/(\d+)\/"/) || [])[1];
    if (!id) continue;
    const title = (b.match(/itemprop="name">([^<]+)</) || [])[1]?.trim() || null;
    const price = Number((b.match(/itemprop="price"[^>]*content="(\d+)"/) || b.match(/content="(\d+)"[^>]*itemprop="price"/) || [])[1]) || null;
    const images = [...new Set(
      [...b.matchAll(/<img[^>]+src="(\/upload\/[^"]+)"/g)].map(m => ORIGIN + m[1]),
    )];
    const feature = label => (b.match(new RegExp(`${label}:</span>\\s*<span>\\s*([\\d\\s.,]+)`)) || [])[1];
    const num = v => (v ? Math.round(Number(v.replace(/[^\d.]/g, ''))) || null : null);
    // Title reads "Villa in Limassol / Potamos Germasogeias".
    const locM = title && title.match(/\bin\s+(.+)$/i);
    const location = locM ? locM[1].replace(/\s*\/\s*/g, ', ') : null;
    out.push({
      id, title, price, images, location,
      houseSqm: num(feature('Total area')),
      plotSqm: num(feature('Plot Size')),
      beds: num(feature('Bedrooms')),
    });
  }
  return out;
}

export async function scrapeDom() {
  const all = [];
  const seen = new Set();
  let done = false;
  for (let start = 1; start <= MAX_PAGES && !done; start += CONCURRENCY) {
    const batch = [];
    for (let p = start; p < start + CONCURRENCY && p <= MAX_PAGES; p++) {
      const url = `${ORIGIN}/en/catalog/sale/type-house/${p === 1 ? '' : `?page=page-${p}`}`;
      batch.push(
        fetch(url, { headers: { 'User-Agent': UA } })
          .then(r => (r.ok ? r.text() : ''))
          .then(parseCards)
          .catch(() => []),
      );
    }
    for (const cards of await Promise.all(batch)) {
      if (cards.length === 0) { done = true; break; }
      let added = 0;
      for (const c of cards) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (c.price == null) continue; // price-on-request
        added++;
        all.push({
          source: 'DOM real estate',
          title: c.title || 'House for sale',
          price: c.price,
          priceDisplay: `€${c.price.toLocaleString('en-US')}`,
          location: c.location || 'Cyprus',
          district: districtFrom(c.location || c.title),
          image: c.images[0] || null,
          images: c.images,
          link: `${ORIGIN}/en/catalog/sale/${c.id}/`,
          houseSqm: c.houseSqm,
          plotSqm: c.plotSqm,
          beds: c.beds,
          baths: null,
          posted: null, postedTs: null, buildYear: null,
          ref: c.id,
        });
      }
      if (added === 0) done = true; // pager past the end repeats content
    }
  }
  return all;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeDom();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} DOM real estate listings.`);
}
