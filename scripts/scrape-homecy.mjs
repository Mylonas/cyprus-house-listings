#!/usr/bin/env node
/**
 * scrape-homecy.mjs
 * Scrapes house listings from home.cy's houses-for-sale search
 * (https://home.cy/real-estate-for-sale/houses?p=N). Also captures the
 * "Presented by" agency/developer name for each listing.
 *
 * Env:
 *   HOMECY_MAX_PAGES - how many result pages to walk, 16 listings/page (default 12)
 */
import { chromium } from 'playwright';

const MAX_PAGES = Number(process.env.HOMECY_MAX_PAGES ?? 20);
const BASE = 'https://home.cy';

export async function scrapeHomeCy() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const all = [];
  const seen = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `${BASE}/real-estate-for-sale/houses?p=${p}`;
    await page.goto(url, { waitUntil: 'networkidle' });

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await scrapeHomeCy();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} home.cy listings.`);
}
