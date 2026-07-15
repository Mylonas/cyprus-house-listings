#!/usr/bin/env node
/**
 * scrape-zyprus.mjs
 * Scrapes house listings from zyprus.com's sale search grid (type_top[]=3 = House).
 *
 * Env:
 *   ZYPRUS_MAX_PAGES - how many result pages to walk, 24 listings/page (default 3)
 */
import { chromium } from 'playwright';

const MAX_PAGES = Number(process.env.ZYPRUS_MAX_PAGES ?? 3);
const BASE = 'https://www.zyprus.com';

export async function scrapeZyprus() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const all = [];

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `${BASE}/search/sale/grid?type_top%5B%5D=3&page=${p}`;
    await page.goto(url, { waitUntil: 'networkidle' });

    const items = await page.evaluate(() => {
      const links = [...new Set(
        [...document.querySelectorAll('a')].map(a => a.href).filter(h => h.includes('/property/'))
      )];

      function extractFor(href) {
        const anchors = [...document.querySelectorAll('a')].filter(a => a.href === href);
        for (const a of anchors) {
          let el = a;
          for (let i = 0; i < 8; i++) {
            if (!el) break;
            const txt = el.innerText || '';
            const imgs = el.querySelectorAll ? [...el.querySelectorAll('img')] : [];
            if (txt.includes('€') && imgs.length) {
              const priceMatch = txt.match(/€\s?[\d.,]+/);
              const lines = txt.split('\n').map(s => s.trim()).filter(Boolean);
              const titleLine = lines.find(l => /for sale/i.test(l)) || '';
              const locLine = lines[lines.length - 1] || '';
              const bestImg = imgs.find(im => im.naturalWidth > 150) || imgs[imgs.length - 1];
              return {
                href, price: priceMatch ? priceMatch[0] : null,
                img: bestImg ? (bestImg.src || bestImg.getAttribute('data-src')) : null,
                title: titleLine, loc: locLine,
              };
            }
            el = el.parentElement;
          }
        }
        return null;
      }

      return links.map(extractFor).filter(Boolean);
    });

    if (items.length === 0) break;
    all.push(...items);
  }

  await browser.close();

  const detectDistrict = (text) => {
    const t = text.toLowerCase();
    for (const d of ['nicosia', 'limassol', 'larnaca', 'paphos', 'famagusta']) {
      if (t.includes(d)) return d[0].toUpperCase() + d.slice(1);
    }
    return 'Other';
  };

  return all.map(d => ({
    source: 'Zyprus',
    title: d.title,
    price: Number((d.price || '').replace('€', '').replace(/,/g, '')) || null,
    priceDisplay: d.price,
    location: d.loc,
    district: detectDistrict(d.loc),
    image: d.img,
    link: d.href,
    houseSqm: null,
    plotSqm: null,
    beds: (d.title.match(/^(\d+)\s*Bedroom/) || [])[1] ? Number(d.title.match(/^(\d+)\s*Bedroom/)[1]) : null,
    baths: null,
    posted: null,
    buildYear: null,
    ref: (d.href.match(/property\/(\d+)/) || [])[1] || null,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await scrapeZyprus();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Zyprus listings.`);
}
