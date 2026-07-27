/**
 * documents.mjs
 * Reads the attachment formats eAuction Cyprus serves from its GetFile endpoint:
 * PDF, Word (.docx and legacy .doc), RTF and bare images. Everything here is
 * dependency-free — a .docx is just a ZIP of XML, and Node ships zlib, so a
 * ~70-line central-directory reader replaces a document-parsing library.
 *
 * Each reader returns the same shape so the harvester can treat any attachment
 * the same way:
 *
 *   { text: string, images: [{ name, data: Buffer }] }
 *
 * PDFs are handled by the harvester itself (pdfjs + sharp are needed for the
 * image XObjects and the column-positioned legal table), not here.
 */
import { inflateRawSync, inflateSync } from 'node:zlib';

/** Identify an attachment from its magic bytes — filenames on this site lie. */
export function sniff(buf) {
  if (!buf || buf.length < 8) return 'empty';
  const hex4 = buf.subarray(0, 4).toString('hex').toUpperCase();
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  if (hex4 === '504B0304' || hex4 === '504B0506') return 'zip';   // docx/xlsx/pptx
  if (hex4 === 'D0CF11E0') return 'ole';                          // legacy .doc/.xls
  if (hex4.startsWith('FFD8FF')) return 'jpeg';
  if (hex4 === '89504E47') return 'png';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 5).toString('latin1').toLowerCase() === '<html' || buf.subarray(0, 9).toString('latin1').toLowerCase() === '<!doctype') return 'html';
  return 'unknown';
}

// ---- ZIP (the container behind every modern Office file) --------------------

/**
 * List a ZIP's entries by walking the central directory backwards from the EOCD
 * record. Returns [{ name, inflate() }] — inflation is lazy so we never expand
 * the 200 MB of embedded media in a file we only wanted the text from.
 */
export function readZip(buf) {
  // The EOCD sits at the end, after a comment of up to 64 KB.
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64 EOCD.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= from; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) {                    // ZIP64 locator
        const z64 = Number(buf.readBigUInt64LE(i + 8));
        if (z64 >= 0 && z64 < buf.length && buf.readUInt32LE(z64) === 0x06064b50) {
          count = Number(buf.readBigUInt64LE(z64 + 32));
          cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
        }
        break;
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
    p += 46 + nameLen + extraLen + commentLen;
    if (localOffset === 0xffffffff || compSize === 0xffffffff) continue; // ZIP64 entry — skip
    entries.push({
      name,
      inflate() {
        // The local header repeats the name/extra with its own lengths; the
        // central directory's are not necessarily the same.
        if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compSize);
        try {
          if (method === 0) return Buffer.from(raw);
          if (method === 8) return inflateRawSync(raw);
          return null; // bzip2/lzma — Office never emits these
        } catch {
          try { return inflateSync(raw); } catch { return null; }
        }
      },
    });
  }
  return entries;
}

// ---- Word ------------------------------------------------------------------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function xmlToText(xml) {
  return xml
    // Paragraph and row breaks become newlines so labels stay off their values.
    .replace(/<\/w:p>|<w:br\b[^>]*\/?>|<\/a:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(\w+);/g, (m, e) => XML_ENTITIES[e] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * .docx → text + embedded media. Headers, footers and footnotes are included:
 * the auction "additional information" forms often put the property table in a
 * header. Media keeps its original bytes (jpeg/png) for the photo pipeline.
 */
export function readDocx(buf) {
  const entries = readZip(buf);
  if (!entries.length) return { text: '', images: [] };

  const textParts = [];
  const order = ['word/document.xml', 'word/header', 'word/footer', 'word/footnotes.xml', 'word/endnotes.xml'];
  const isTextPart = n => order.some(o => n === o || n.startsWith(o)) && n.endsWith('.xml');
  for (const e of entries.filter(e => isTextPart(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const data = e.inflate();
    if (data) textParts.push(xmlToText(data.toString('utf-8')));
  }

  const images = [];
  for (const e of entries.filter(e => /^word\/media\//i.test(e.name) && /\.(jpe?g|png|gif|bmp|webp|tiff?|emf|wmf)$/i.test(e.name))) {
    const data = e.inflate();
    if (data && data.length > 8000) images.push({ name: e.name.split('/').pop(), data });
  }
  return { text: textParts.join('\n'), images };
}

/** .xlsx → flattened cell text (shared strings + inline). Rare, but cheap to support. */
export function readXlsx(buf) {
  const entries = readZip(buf);
  const shared = [];
  const ss = entries.find(e => e.name === 'xl/sharedStrings.xml')?.inflate();
  if (ss) for (const m of ss.toString('utf-8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlToText(m[1]));
  const parts = [];
  for (const e of entries.filter(e => /^xl\/worksheets\/.*\.xml$/.test(e.name))) {
    const data = e.inflate();
    if (!data) continue;
    const xml = data.toString('utf-8');
    for (const m of xml.matchAll(/<c\b[^>]*?(?:\st="(\w+)")?[^>]*>\s*<v>([^<]*)<\/v>/g)) {
      parts.push(m[1] === 's' ? (shared[Number(m[2])] ?? '') : m[2]);
    }
  }
  const images = [];
  for (const e of entries.filter(e => /^xl\/media\//i.test(e.name))) {
    const data = e.inflate();
    if (data && data.length > 8000) images.push({ name: e.name.split('/').pop(), data });
  }
  return { text: parts.join(' '), images };
}

/** Dispatch a ZIP-based Office file by what's inside it, not by its extension. */
export function readOfficeZip(buf) {
  const names = readZip(buf).map(e => e.name);
  if (names.some(n => n.startsWith('word/'))) return { kind: 'docx', ...readDocx(buf) };
  if (names.some(n => n.startsWith('xl/'))) return { kind: 'xlsx', ...readXlsx(buf) };
  return { kind: 'zip', text: '', images: [] };
}

// ---- Legacy .doc (OLE2 compound file) --------------------------------------

const GREEK = /[Ͱ-Ͽἀ-῿]/;

/**
 * Legacy Word 97-2003. Proper extraction means parsing the FIB and the piece
 * table; we only ever regex labelled numbers out of these, so a text-run scan
 * is the right cost. Word stores text as UTF-16LE (or CP1253 for old Greek
 * docs), so scan for both and keep runs that look like prose.
 *
 * Returns text only — images in .doc live in a binary Escher/ObjectPool blob
 * that is not worth decoding; the harvester logs when it hits one.
 */
export function readLegacyDoc(buf) {
  const runs = [];

  // UTF-16LE runs: printable char followed by a zero high byte.
  let cur = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i], hi = buf[i + 1];
    const code = lo | (hi << 8);
    const printable = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0x24f) ||
      (code >= 0x370 && code <= 0x3ff) || (code >= 0x1f00 && code <= 0x1fff) || code === 0x9;
    if (printable) cur += String.fromCharCode(code);
    else { if (cur.length >= 12) runs.push(cur); cur = ''; }
  }
  if (cur.length >= 12) runs.push(cur);

  // Single-byte runs decoded as CP1253 (Greek) — Word 97 wrote these for
  // Greek-locale documents.
  const cp1253 = new TextDecoder('windows-1253', { fatal: false });
  cur = '';
  const bytes = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if ((b >= 0x20 && b <= 0x7e) || b >= 0xa0) bytes.push(b);
    else {
      if (bytes.length >= 16) {
        const s = cp1253.decode(Uint8Array.from(bytes));
        if (/[A-Za-zͰ-Ͽ]{4}/.test(s)) runs.push(s);
      }
      bytes.length = 0;
    }
  }
  if (bytes.length >= 16) runs.push(cp1253.decode(Uint8Array.from(bytes)));

  const text = runs
    .filter(r => /[A-Za-zͰ-Ͽ]{3}/.test(r))       // drop binary noise
    .filter(r => !/^(?:Microsoft|Word\.Document|MSWordDoc|Root Entry|WordDocument|SummaryInformation|DocumentSummaryInformation|Times New Roman|Arial|Calibri|Cambria)/i.test(r.trim()))
    .join('\n');
  return { text, images: [], lossy: true, greek: GREEK.test(text) };
}

// ---- RTF -------------------------------------------------------------------

/** RTF → text, including \uN Unicode escapes and \'hh Greek code-page bytes. */
export function readRtf(buf) {
  const src = buf.toString('latin1');
  const text = src
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\s?\??/g, (_, d) => String.fromCharCode(((Number(d) % 65536) + 65536) % 65536))
    .replace(/\{\\\*[^{}]*\}/g, ' ')     // ignorable destinations (fonts, styles)
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\[a-z]+-?\d*\s?/gi, ' ')  // remaining control words
    .replace(/[{}]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Embedded pictures are hex-encoded blobs; pull the jpegs/pngs out.
  const images = [];
  for (const m of src.matchAll(/\\pict[^{}]*?(?:\\jpegblip|\\pngblip)([\s\S]*?)\}/g)) {
    const hex = m[1].replace(/[^0-9a-f]/gi, '');
    if (hex.length < 20000) continue;                       // too small to be a photo
    const data = Buffer.from(hex, 'hex');
    const kind = sniff(data);
    if (kind === 'jpeg' || kind === 'png') images.push({ name: `rtf-${images.length + 1}.${kind === 'jpeg' ? 'jpg' : 'png'}`, data });
  }
  return { text, images };
}

/**
 * One entry point for any non-PDF attachment: returns { kind, text, images }.
 * `kind` is reported so callers can log what the site actually serves.
 */
export function readDocument(buf) {
  const kind = sniff(buf);
  switch (kind) {
    case 'zip': return readOfficeZip(buf);
    case 'ole': return { kind: 'doc', ...readLegacyDoc(buf) };
    case 'rtf': return { kind: 'rtf', ...readRtf(buf) };
    case 'jpeg': case 'png': case 'gif': case 'webp':
      return { kind, text: '', images: [{ name: `attachment.${kind === 'jpeg' ? 'jpg' : kind}`, data: buf }] };
    default: return { kind, text: '', images: [] };
  }
}
