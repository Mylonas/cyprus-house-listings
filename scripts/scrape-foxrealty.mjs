#!/usr/bin/env node
/**
 * scrape-foxrealty.mjs
 * Scrapes house listings directly from FOX Smart Estate Agency's own site
 * (foxrealty.com.cy) — the single largest agency/developer presence found
 * on home.cy. Walks one page per Cyprus district (their own pagination is
 * AJAX-driven with no stable URL, so this captures page 1 per district,
 * ~12 listings each).
 */
import { chromium } from 'playwright';

const BASE = 'https://foxrealty.com.cy';
const DISTRICTS = ['nicosia', 'limassol', 'larnaca', 'paphos', 'famagusta'];

export async function scrapeFoxRealty() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const all = [];
  const seen = new Set();

  for (const d of DISTRICTS) {
    const url = `${BASE}/for_sale-residential/type-houses/${d}`;
    await page.goto(url, { waitUntil: 'networkidle' });

    const items = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('div.listing-item');
      for (const card of cards) {
        const link = card.querySelector('a[href*="/property/"]');
        const href = link ? link.href : null;
        const img = card.querySelector('img');
        const image = img ? (img.src || img.getAttribute('data-src')) : null;
        const text = card.textContent.replace(/\s+/g, ' ').trim();
        const refMatch = text.match(/#(\d+)/);
        const ref = refMatch ? refMatch[1] : null;
        const priceMatch = text.match(/€\s*([\d.,]+)/);
        const price = priceMatch ? parseInt(priceMatch[1].replace(/[.,]/g, '')) : null;
        const sqmMatches = [...text.matchAll(/(\d+)\s*m²/g)].map(m => parseInt(m[1]));
        const houseSqm = sqmMatches[0] || null;
        const plotSqm = sqmMatches[1] || null;
        const locMatch = text.match(/FOR SALE\s*([A-Za-z\s]+),\s*([A-Za-z\s]+?)\s*(House|Villa|Bungalow|Townhouse|Semi-detached)/);
        const district = locMatch ? locMatch[1].trim() : null;
        const location = locMatch ? locMatch[2].trim() : null;
        const type = locMatch ? locMatch[3].trim() : null;
        const numsAfterRef = ref ? text.split('#' + ref)[1] : null;
        const bedsBathsMatch = numsAfterRef ? numsAfterRef.match(/^\s*(\d+)\s*(\d+)/) : null;
        const beds = bedsBathsMatch ? parseInt(bedsBathsMatch[1]) : null;
        const baths = bedsBathsMatch ? parseInt(bedsBathsMatch[2]) : null;
        results.push({ ref, type, district, location, price, beds, baths, houseSqm, plotSqm, image, href });
      }
      return results;
    });

    for (const it of items) {
      if (it.ref && !seen.has(it.ref)) { seen.add(it.ref); all.push(it); }
    }
  }

  await browser.close();

  return all.map(d => ({
    source: 'FOX Realty',
    title: d.type ? `${d.type} for sale` : 'House for sale',
    price: d.price,
    priceDisplay: d.price ? `€${d.price.toLocaleString('en-US')}` : null,
    location: d.location,
    district: d.district,
    image: d.image,
    link: d.href,
    houseSqm: d.houseSqm,
    plotSqm: d.plotSqm,
    beds: d.beds,
    baths: d.baths,
    posted: null,
    buildYear: null,
    ref: d.ref,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await scrapeFoxRealty();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} FOX Realty listings.`);
}
