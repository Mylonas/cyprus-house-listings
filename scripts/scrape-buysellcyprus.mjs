#!/usr/bin/env node
/**
 * scrape-buysellcyprus.mjs
 * Scrapes house listings from buysellcyprus.com's "recently listed" search
 * (type-house, sorted newest first). The site has ~28,000 house listings total,
 * so this walks a bounded number of pages (24 listings/page) rather than the
 * full catalogue — matching the internal page's "recent sample" approach for
 * this source.
 *
 * Env:
 *   BSC_MAX_PAGES - how many result pages to walk, 24 listings/page (default 15)
 */
import { chromium } from 'playwright';

const MAX_PAGES = Number(process.env.BSC_MAX_PAGES ?? 15);
const BASE = 'https://www.buysellcyprus.com';

export async function scrapeBuySellCyprus() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const all = [];
  const seen = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `${BASE}/properties-for-sale/type-house/sort-rl/page-${p}`;
    await page.goto(url, { waitUntil: 'networkidle' });

    const items = await page.evaluate(() => {
      const titles = document.querySelectorAll('div.bs-card-title');
      const results = [];
      for (const titleDiv of titles) {
        const card = titleDiv.closest('section.listing-simple') || titleDiv.closest('section');
        if (!card) continue;
        let descText = '';
        const sib = card.nextElementSibling;
        if (sib && !sib.querySelector('.bs-card-title') && !sib.classList.contains('listing-simple')) {
          descText = sib.textContent.trim();
        }
        const h2 = titleDiv.querySelector('h2');
        const titleText = h2 ? h2.textContent.trim() : titleDiv.textContent.trim();
        const idMatch = titleText.match(/ID:\s*(\d+)/);
        const ref = idMatch ? idMatch[1] : null;
        const linkEl = card.querySelector('a[href*=".html"]');
        const link = linkEl ? linkEl.href.split('?')[0] : null;
        const locEl = card.querySelector('.bs-card-text');
        const location = locEl ? locEl.textContent.trim() : null;
        const priceEl = card.querySelector('.bs-listing-price');
        const priceText = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : null;
        const imgEl = card.querySelector('img[data-src]:not([data-src*="whiteimg"])') || card.querySelector('img.js-lazy-image');
        const image = imgEl ? (imgEl.getAttribute('data-src') || imgEl.src) : null;
        const bedMatch = titleText.match(/(\d+)\s*Bedroom/i);
        const beds = bedMatch ? parseInt(bedMatch[1]) : null;
        const houseSqmMatch = descText.match(/(?:internal covered area|covered area|built area)[^\d]{0,15}(\d+)\s*(?:sq\.?\s?m|sqrm|m2|m²)/i);
        const houseSqm = houseSqmMatch ? parseInt(houseSqmMatch[1]) : null;
        const plotSqmMatch = descText.match(/plot area[^\d]{0,15}(\d+)\s*(?:sq\.?\s?m|sqrm|m2|m²)/i);
        const plotSqm = plotSqmMatch ? parseInt(plotSqmMatch[1]) : null;
        const builtYearMatch = descText.match(/(?:built|constructed) in (\d{4})/i);
        const buildYear = builtYearMatch ? parseInt(builtYearMatch[1]) : null;
        results.push({ ref, titleText, link, location, priceText, image, beds, houseSqm, plotSqm, buildYear });
      }
      return results;
    });

    if (items.length === 0) break;
    for (const it of items) {
      if (it.ref && !seen.has(it.ref)) { seen.add(it.ref); all.push(it); }
    }
  }

  await browser.close();

  return all
    .filter(d => !d.image || !d.image.includes('thumbnails'))
    .map(d => ({
      source: 'BuySellCyprus',
      title: d.beds ? `${d.beds} Bedroom house for sale` : 'House for sale',
      price: (() => {
        const m = (d.priceText || '').match(/€([\d,]+)/);
        return m ? parseInt(m[1].replace(/,/g, '')) : null;
      })(),
      priceDisplay: d.priceText,
      location: d.location,
      district: null,
      image: d.image,
      link: d.link,
      houseSqm: d.houseSqm,
      plotSqm: d.plotSqm,
      beds: d.beds,
      baths: null,
      posted: null,
      buildYear: d.buildYear,
      ref: d.ref,
    }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await scrapeBuySellCyprus();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} BuySellCyprus listings.`);
}
