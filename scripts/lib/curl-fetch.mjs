/**
 * curl-fetch.mjs
 * Fetches a URL by shelling out to curl instead of using Node's built-in fetch.
 *
 * Why: Cloudflare fingerprints the TLS handshake (JA3), not just headers.
 * Node's undici handshake is flagged on zyprus.com and bazaraki.com — a plain
 * `fetch()` gets a 403 challenge page — while curl's handshake passes and
 * returns the real content. Sending identical headers from `fetch()` does not
 * help; the fingerprint is below the HTTP layer.
 *
 * This replaced the stealth-browser approach both scrapers used to need. A
 * headless browser is a heavier fingerprint than curl, not a lighter one, and
 * it cost ~40s of Chromium startup per source.
 *
 * If a site starts 403ing curl too, the escalation path is a real browser
 * (see scrape-eauction.mjs), not more headers.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeoutMs?: number, maxBuffer?: number}} [opts]
 * @returns {Promise<string>} response body
 */
export async function curlFetch(url, opts = {}) {
  const { headers = {}, timeoutMs = 60000, maxBuffer = 64 * 1024 * 1024 } = opts;

  const args = [
    '-s',
    '-S',
    '--compressed',
    '--fail-with-body',
    '--max-time',
    String(Math.ceil(timeoutMs / 1000)),
    '-A',
    UA,
    // Windows curl uses Schannel, which fails on some CRL endpoints; harmless
    // and ignored by the OpenSSL curl on the CI runners.
    '--ssl-no-revoke',
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);

  // Append the status code so failures say *what* went wrong. Without this a
  // 403 challenge and a DNS failure produce the same opaque "Command failed".
  args.push('-w', '\\n%{http_code}');

  let stdout;
  try {
    ({ stdout } = await execFileAsync('curl', args, { maxBuffer, encoding: 'utf-8' }));
  } catch (err) {
    const tail = String(err.stdout ?? '').trim().split('\n').pop();
    throw new Error(`curl failed (HTTP ${tail || '?'}) for ${url}`);
  }

  const nl = stdout.lastIndexOf('\n');
  const status = stdout.slice(nl + 1).trim();
  const body = stdout.slice(0, nl);
  if (!/^2\d\d$/.test(status)) throw new Error(`HTTP ${status} for ${url}`);
  return body;
}

export async function curlFetchJson(url, opts = {}) {
  const body = await curlFetch(url, {
    ...opts,
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...opts.headers },
  });
  return JSON.parse(body);
}

/** Cloudflare's interstitial, as opposed to a real page that merely loads their JS. */
export const isChallenge = (html) =>
  /<title>\s*Just a moment/i.test(html) || /cf-browser-verification/i.test(html);
