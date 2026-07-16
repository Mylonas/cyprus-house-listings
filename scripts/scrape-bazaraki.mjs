#!/usr/bin/env node
/**
 * scrape-bazaraki.mjs
 * Scrapes house listings from bazaraki.com for each Cyprus district.
 * Bazaraki uses an infinite-scroll grid, so we scroll N times per district
 * before reading the rendered cards out of the DOM.
 *
 * Env:
 *   BAZARAKI_SCROLLS - how many scroll passes per district (default 6)
 */
import { chromium } from 'playwright';

const SCROLLS = Number(process.env.BAZARAKI_SCROLLS ?? 6);
const DISTRICTS = [
  { slug: 'lefkosia-district-nicosia', name: 'Nicosia' },
  { slug: 'lemesos-district-limassol', name: 'Limassol' },
  { slug: 'larnaka-district-larnaca', name: 'Larnaca' },
  { slug: 'pafos-district-paphos', name: 'Paphos' },
];

async function scrapeDistrict(page, district) {
  // 'networkidle' never settles on modern ad/analytics-heavy pages; wait for
  // the listing links themselves instead.
  await page.goto(
    `https://www.bazaraki.com/real-estate-for-sale/houses/${district.slug}/`,
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForSelector('a[href*="/adv/"]', { timeout: 30000 });

  for (let i = 0; i < SCROLLS; i++) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(1200);
  }

  return page.evaluate((districtName) => {
    const links = [...new Set(
      [...document.querySelectorAll('a[href*="/adv/"]')].map(a => a.href)
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
            const locLine = lines.find(l => l.includes(districtName)) || '';
            const dateLine = lines.find(l =>
              /today|yesterday|days? ago|weeks? ago|hours? ago|minutes? ago/i.test(l)
            ) || '';
            const sqms = [...txt.matchAll(/(\d[\d,]*)\s?m²/g)].map(m => m[1]);
            const bedMatch = txt.match(/(\d+)-bedroom/i);
            const bestImg = imgs.find(im => im.naturalWidth > 150) || imgs[imgs.length - 1];
            return {
              href, price: priceMatch ? priceMatch[0] : null,
              img: bestImg ? (bestImg.src || bestImg.getAttribute('data-src')) : null,
              title: titleLine, loc: locLine, date: dateLine,
              sqm1: sqms[0] || null, sqm2: sqms[1] || null,
              beds: bedMatch ? Number(bedMatch[1]) : null,
            };
          }
          el = el.parentElement;
        }
      }
      return null;
    }

    const seen = new Set();
    return links
      .map(extractFor)
      .filter(Boolean)
      .filter(d => d.loc && d.loc.length > 0)
      .filter(d => {
        const key = [d.price, d.title, d.loc, d.img].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(d => ({
        id: (d.href.match(/adv\/(\d+)_/) || [])[1] || null,
        href: d.href,
        price: d.price,
        title: d.title,
        loc: d.loc,
        date: d.date,
        sqm1: d.sqm1,
        sqm2: d.sqm2,
        beds: d.beds,
        img: d.img,
      }));
  }, district.name);
}

export async function scrapeBazaraki() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const all = [];

  for (const district of DISTRICTS) {
    const items = await scrapeDistrict(page, district);
    all.push(...items);
  }

  await browser.close();

  return all.map(d => ({
    source: 'Bazaraki',
    title: d.title,
    price: Number((d.price || '').replace('€', '').replace(/\./g, '')) || null,
    priceDisplay: d.price,
    location: d.loc,
    district: d.loc.split(',')[0].trim(),
    image: d.img,
    link: d.href,
    houseSqm: d.sqm1 ? Number(d.sqm1.replace(/,/g, '')) : null,
    plotSqm: d.sqm2 ? Number(d.sqm2.replace(/,/g, '')) : null,
    beds: d.beds,
    baths: null,
    posted: d.date,
    buildYear: null,
    ref: d.id,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await scrapeBazaraki();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Bazaraki listings.`);
}
