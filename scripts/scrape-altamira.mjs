#!/usr/bin/env node
/**
 * scrape-altamira.mjs
 * Scrapes house listings from altamirarealestate.com.cy.
 * Clicks "View more" repeatedly to load additional listings, then extracts
 * price, title, link, image, size (m²), bedrooms and bathrooms per card.
 *
 * Env:
 *   ALTAMIRA_MAX_CLICKS  - how many times to click "View more" (default 15)
 */
import { chromium } from 'playwright';

const MAX_CLICKS = Number(process.env.ALTAMIRA_MAX_CLICKS ?? 15);
const BASE = 'https://www.altamirarealestate.com.cy';

export async function scrapeAltamira() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/houses-for-sale`, { waitUntil: 'networkidle' });

  for (let i = 0; i < MAX_CLICKS; i++) {
    const btn = await page.$('input[type="submit"][value="View more"]');
    if (!btn) break;
    await btn.click();
    await page.waitForTimeout(1500);
  }

  const raw = await page.evaluate(() => {
    return [...document.querySelectorAll('article')].map(a => {
      const h = a.querySelector('h2, h3, h4, .h4, [class*="title"]');
      const link = a.querySelector(
        'a[href*="-for-sale"], a[href*="/paphos/"], a[href*="/nicosia/"], a[href*="/limassol/"], a[href*="/larnaca/"], a[href*="/famagusta/"]'
      );
      const img = a.querySelector('img');
      const text = a.textContent.replace(/\s+/g, ' ').trim();
      const priceMatch = text.match(/€[\d,.]+/);
      const sqmMatch = text.match(/(\d+)\s?m2/);
      const bedMatch = text.match(/(\d+)\s?Bedrooms?/i);
      const bathMatch = text.match(/(\d+)\s?Bathrooms?/i);
      return {
        ref: (text.match(/\b([A-Z]{2}\d{4,6})\b/) || [])[1] || null,
        title: h ? h.textContent.trim() : null,
        link: link ? link.getAttribute('href') : null,
        img: img ? img.src || img.getAttribute('data-src') : null,
        price: priceMatch ? priceMatch[0] : null,
        sqm: sqmMatch ? Number(sqmMatch[1]) : null,
        beds: bedMatch ? Number(bedMatch[1]) : null,
        baths: bathMatch ? Number(bathMatch[1]) : null,
      };
    });
  });

  await browser.close();

  const detectDistrict = (text) => {
    const t = text.toLowerCase();
    for (const d of ['nicosia', 'limassol', 'larnaca', 'paphos', 'famagusta']) {
      if (t.includes(d)) return d[0].toUpperCase() + d.slice(1);
    }
    return 'Other';
  };

  return raw
    .filter(r => r.title && r.price)
    .map(r => ({
      source: 'Altamira Real Estate',
      title: r.title,
      price: Number((r.price || '').replace('€', '').replace(/,/g, '')) || null,
      priceDisplay: r.price,
      location: r.title.includes(' - ') ? r.title.split(' - ').slice(1).join(' - ').trim() : r.title,
      district: detectDistrict(r.title),
      image: r.img && r.img.startsWith('http') ? r.img : (r.img ? BASE + r.img : null),
      link: r.link ? (r.link.startsWith('http') ? r.link : BASE + r.link) : BASE,
      houseSqm: r.sqm,
      plotSqm: null,
      beds: r.beds,
      baths: r.baths,
      posted: null,
      buildYear: null,
      ref: r.ref,
    }));
}

// Allow standalone execution: `node scripts/scrape-altamira.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await scrapeAltamira();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Altamira listings.`);
}
