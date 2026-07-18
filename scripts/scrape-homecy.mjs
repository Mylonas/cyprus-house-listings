#!/usr/bin/env node
/**
 * scrape-homecy.mjs
 * Scrapes house listings from home.cy's houses-for-sale search
 * (https://home.cy/real-estate-for-sale/houses?p=N). Also captures the
 * "Presented by" agency/developer name for each listing.
 *
 * ACCESS NOTE (2026-07-19)
 * ------------------------
 * home.cy now gates its listing pages behind an *interactive* Cloudflare
 * Turnstile challenge (the search page loops on challenge-platform 401s and the
 * `div.item.standard` grid never renders), and its robots.txt / Terms &
 * Conditions explicitly prohibit automated scraping without prior written
 * approval. We therefore do NOT try to defeat the challenge. The scraper is kept
 * intact and simply *detects the wall and returns nothing gracefully* — fast,
 * with a clear log — so the source degrades cleanly within scrape-all instead of
 * hanging on a 30s-per-page `networkidle` timeout. If access is ever restored
 * (challenge removed, or written approval + an allow-listed IP), the parsing
 * below resumes working unchanged.
 *
 * Env:
 *   HOMECY_MAX_PAGES - how many result pages to walk, 16 listings/page (default 20)
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const MAX_PAGES = Number(process.env.HOMECY_MAX_PAGES ?? 20);
const BASE = 'https://home.cy';

// Quick probe: is the listing grid reachable, or are we hitting the Turnstile
// wall? Returns true only if real listing cards render.
async function gridIsReachable(page) {
  try {
    await page.goto(`${BASE}/real-estate-for-sale/houses?p=1`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch {
    return false;
  }
  try {
    await page.waitForSelector('div.item.standard', { timeout: 12000 });
    return true;
  } catch {
    return false;
  }
}

export async function scrapeHomeCy() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const all = [];
  const seen = new Set();

  if (!(await gridIsReachable(page))) {
    await browser.close();
    console.error(
      'home.cy: listing grid unreachable (Cloudflare Turnstile challenge / ' +
      'ToS-prohibited scraping) — returning 0 listings. Not attempting to bypass.'
    );
    return [];
  }

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `${BASE}/real-estate-for-sale/houses?p=${p}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForSelector('div.item.standard', { timeout: 12000 });
    } catch {
      break; // wall re-appeared or no more pages
    }

    const items = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('div.item.standard');
      for (const card of cards) {
        const link = card.querySelector('a[href*="/real-estate-for-sale/"]') || card.querySelector('a');
        const href = link ? link.href.split('?')[0] : null;
        const img = card.querySelector('img');
        let image = img ? (img.src || img.getAttribute('data-src')) : null;
        if (image) image = image.split('?')[0];
        const text = card.textContent.replace(/\s+/g, ' ').trim();
        const typeMatch = text.match(/^(Villa|Bungalow|Semi-detached house|Detached house|Townhouse|Town house|Link-detached house|House)/);
        const type = typeMatch ? typeMatch[1] : null;
        const priceMatch = text.match(/€([\d,]+)/);
        const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null;
        const bedsMatch = text.match(/(\d+)\s*beds?/i);
        const beds = bedsMatch ? parseInt(bedsMatch[1]) : null;
        const bathsMatch = text.match(/(\d+)\s*baths?/i);
        const baths = bathsMatch ? parseInt(bathsMatch[1]) : null;
        const sqmMatch = text.match(/(\d+)\s*m²/);
        const sqm = sqmMatch ? parseInt(sqmMatch[1]) : null;
        const locMatch = text.match(/m²\s*([A-Za-zͰ-Ͽ\s]+,\s*[A-Za-zͰ-Ͽ\s]+?)\s*Presented/);
        const location = locMatch ? locMatch[1].trim() : null;
        const presentedMatch = text.match(/Presented by\s*(.+)$/);
        const presentedBy = presentedMatch ? presentedMatch[1].trim() : null;
        const ref = href ? (href.match(/-(\d+)$/) || [])[1] : null;
        results.push({ ref, type, price, beds, baths, sqm, location, presentedBy, image, href });
      }
      return results;
    });

    if (items.length === 0) break;
    for (const it of items) {
      if (it.ref && !seen.has(it.ref)) { seen.add(it.ref); all.push(it); }
    }
  }

  await browser.close();

  return all.map(d => {
    let loc = d.location, district = null;
    if (d.location && d.location.includes(',')) {
      const parts = d.location.split(',').map(s => s.trim());
      loc = parts[0];
      district = parts[parts.length - 1];
    }
    return {
      source: 'home.cy',
      title: d.type ? `${d.type} for sale` : 'House for sale',
      price: d.price,
      priceDisplay: d.price ? `€${d.price.toLocaleString('en-US')}` : null,
      location: loc,
      district,
      image: d.image,
      link: d.href,
      houseSqm: d.sqm,
      plotSqm: null,
      beds: d.beds,
      baths: d.baths,
      posted: null,
      buildYear: null,
      ref: d.ref,
      agent: d.presentedBy,
    };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeHomeCy();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} home.cy listings.`);
}
