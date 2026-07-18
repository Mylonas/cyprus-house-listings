#!/usr/bin/env node
/**
 * scrape-bidx1.mjs
 * Scrapes Cyprus "Houses" auction listings from bidx1.com, a pan-European
 * (Ireland/UK/South Africa/Cyprus) online property auction platform.
 *
 * The Cyprus/Houses filtered view lives at a fixed URL with query params
 * for division/region/property type — no pagination was needed at time of
 * writing (all results render on one page), but the loop below is kept in
 * case that changes.
 *
 * Env:
 *   BIDX1_MAX_SCROLLS - scroll passes to trigger any lazy-loaded cards (default 4)
 */
import { chromium } from 'playwright';

const SCROLLS = Number(process.env.BIDX1_MAX_SCROLLS ?? 8);
const BASE = 'https://bidx1.com';
// division=80 -> Cyprus, propertytypes=2 -> Houses (discovered via the site's own filter UI)
const URL = `${BASE}/en/cyprus?division=80&region=4&propertytypes=2`;

export async function scrapeBidx1() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });

  for (let i = 0; i < SCROLLS; i++) {
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(800);
  }

  const raw = await page.evaluate(() => {
    const links = [...new Set(
      [...document.querySelectorAll('a')]
        .map(a => a.getAttribute('href'))
        .filter(h => h && h.includes('/auction/property/'))
    )];

    function extractFor(href) {
      const anchors = [...document.querySelectorAll('a')].filter(a => a.getAttribute('href') === href);
      for (const a of anchors) {
        let el = a;
        for (let i = 0; i < 8; i++) {
          if (!el) break;
          const txt = el.innerText || '';
          const imgs = el.querySelectorAll ? [...el.querySelectorAll('img')] : [];
          if ((txt.includes('€') || txt.includes('Reserve')) && imgs.length) {
            const priceMatch = txt.match(/€\s?[\d.,]+/);
            const lines = txt.split('\n').map(s => s.trim()).filter(Boolean);
            const locLine = lines.find(l => /Cyprus/i.test(l)) || '';
            const titleLine = lines.find(l => l.length > 15 && !/Reserve|Cyprus|Registration|Bidding/i.test(l)) || '';
            const bedMatch = txt.match(/(\d+)\s*Beds?/i);
            const bestImg = imgs.find(im => im.naturalWidth > 150) || imgs[imgs.length - 1];
            return {
              href, price: priceMatch ? priceMatch[0] : null,
              img: bestImg ? (bestImg.src || bestImg.getAttribute('data-src')) : null,
              title: titleLine, loc: locLine,
              beds: bedMatch ? Number(bedMatch[1]) : null,
            };
          }
          el = el.parentElement;
        }
      }
      return null;
    }

    return links.map(extractFor).filter(Boolean);
  });

  await browser.close();

  const detectDistrict = (text) => {
    const t = text.toLowerCase();
    for (const d of ['nicosia', 'limassol', 'larnaca', 'paphos', 'famagusta']) {
      if (t.includes(d)) return d[0].toUpperCase() + d.slice(1);
    }
    return 'Other';
  };

  return raw.map(d => ({
    source: 'BidX1',
    title: d.title || 'House auction listing',
    price: d.price ? Number(d.price.replace('€', '').replace(/\./g, '')) : null,
    priceDisplay: d.price ? `${d.price} (reserve)` : null,
    location: d.loc,
    district: detectDistrict(d.loc),
    image: d.img,
    link: d.href.startsWith('http') ? d.href : BASE + d.href,
    houseSqm: null,
    plotSqm: null,
    beds: d.beds,
    baths: null,
    posted: null,
    buildYear: null,
    ref: (d.href.match(/property\/(\d+)/) || [])[1] || null,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await scrapeBidx1();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} BidX1 listings.`);
}
