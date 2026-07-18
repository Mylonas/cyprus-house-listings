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
import { pathToFileURL } from 'node:url';

const MAX_CLICKS = Number(process.env.ALTAMIRA_MAX_CLICKS ?? 15);
const BASE = 'https://www.altamirarealestate.com.cy';

export async function scrapeAltamira() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/houses-for-sale`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 30000 });

  for (let i = 0; i < MAX_CLICKS; i++) {
    // The cookie-consent overlay intercepts pointer events over the whole
    // page; strip it so "View more" is clickable (no consent is given).
    await page.evaluate(() => document.querySelector('#cookiescript_injected_wrapper')?.remove());
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

  const listings = raw
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

  await enrichFromDetails(listings);
  return listings;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// List cards carry no plot area. The detail page (plain server-rendered HTML)
// has a spec list — `superf_land` (plot), `hab` (bedrooms), `ban` (bathrooms) —
// and a free-text "built ... 1985" mention. Fetch each detail page and fill
// plot, plus any missing beds/baths/year. Gentle: small worker pool with spacing.
async function enrichFromDetails(listings) {
  const grab = (h, re) => { const m = h.match(re); if (!m) return null; const n = Number(m[1].replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
  const CONCURRENCY = 5;
  let i = 0;
  async function worker() {
    while (i < listings.length) {
      const l = listings[i++];
      if (!l.link || l.link === BASE) continue;
      try {
        const res = await fetch(l.link, { headers: { 'User-Agent': UA } });
        if (!res.ok) continue;
        const h = await res.text();
        l.plotSqm = grab(h, /class="superf_land">\s*([\d,]+)\s*m/i);
        if (l.beds == null) l.beds = grab(h, /class="hab">\s*(\d+)/i);
        if (l.baths == null) l.baths = grab(h, /class="ban">\s*(\d+)/i);
        const year = grab(h, /built[^.]{0,20}?\b((?:18|19|20)\d{2})\b/i);
        if (year && year > 1800 && year < 2100) l.buildYear = year;
      } catch {
        /* leave fields as-is on a failed detail fetch */
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// Allow standalone execution: `node scripts/scrape-altamira.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeAltamira();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Altamira listings.`);
}
