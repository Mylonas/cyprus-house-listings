/**
 * curl-fetch.mjs
 * Fetches a URL by shelling out to curl instead of using Node's built-in fetch.
 *
 * Why: on zyprus.com and bazaraki.com, Node's `fetch()` gets a 403 Cloudflare
 * challenge where curl — same URL, same headers — gets a 200. Something below
 * the HTTP layer differs; sending identical headers from `fetch()` does not
 * help. This replaced a stealth-patched headless browser that Cloudflare had
 * also started flagging, and saves ~40s of Chromium startup per source.
 *
 * This only holds from a residential IP. From a datacenter IP (GitHub Actions
 * runners included) *every* client gets challenged, curl included — see the
 * measurements in README.md. curl is not a way around a reputation block, only
 * around whatever undici is doing differently.
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

  // curl reports connection-level failures (timeout, reset, DNS) as status 000.
  // Those are transient and worth retrying; a 4xx is the server's considered
  // answer and retrying it just burns requests. Getting this wrong is expensive:
  // the scrapers stop walking a district on error, so one dropped connection
  // used to cost a whole district — Larnaca came back empty exactly this way.
  let lastStatus = '?';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync('curl', args, { maxBuffer, encoding: 'utf-8' }));
    } catch (err) {
      stdout = String(err.stdout ?? '');
    }

    const nl = stdout.lastIndexOf('\n');
    const status = nl === -1 ? '000' : stdout.slice(nl + 1).trim();
    if (/^2\d\d$/.test(status)) return stdout.slice(0, nl);

    lastStatus = status || '000';
    if (lastStatus !== '000') break; // a real HTTP status — do not retry
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500));
  }

  throw new Error(`HTTP ${lastStatus} for ${url}`);
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
