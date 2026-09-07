// src/lib/pdf/pdfInfoDictionary.ts
//
// Write a PDF's document information dictionary — title, author, subject,
// creator — into bytes Chromium already produced.
//
// WHY THIS EXISTS. `page.pdf()` exposes no metadata option, so the Playwright
// transport declared `capabilities: { metadata: false }` and logged that it
// was dropping what the call site asked for. `pdfinfo` on the rendered board
// pack read `Custom Metadata: no`, `Creator: Chromium`: a document a director
// forwards to their bank named neither the company nor the pack, and the
// route's `buildPdfMetadata` call had no effect on the one transport
// production falls back to during an incident.
//
// It is an INCREMENTAL UPDATE, which is what the format is for: the original
// bytes are untouched, a new revision of the Info object is appended, and a
// small cross-reference section points at it with `/Prev` chaining back to
// the xref that was already there (PDF 1.7 §7.5.6). Nothing is re-serialised,
// so nothing about the page content can be damaged by this file.
//
// It refuses rather than guesses. Chromium's Skia writer emits a classic
// cross-reference TABLE and a literal `trailer` dictionary; a PDF using
// cross-reference STREAMS cannot take a classic xref section appended to it,
// and this returns the input unchanged in that case (and in any other it does
// not fully understand). A cosmetic gap must not become a PDF outage — the
// same trade `playwrightTransport` already documents.

import { log } from '@/lib/logger';
import type { PdfMetadata } from './pdfTransport';

/** The standard Info keys this writer sets, in the order a reader tends to
 *  want them. `metadata.custom` is written after these — see `PdfMetadata`
 *  for why a standard-only dictionary still reads `Custom Metadata: no`. */
const KEYS: ReadonlyArray<[keyof Omit<PdfMetadata, 'custom'>, string]> = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['creator', 'Creator'],
];

/**
 * A custom key's NAME, as a PDF name object.
 *
 * A name is written `/Foo`, and the delimiters and whitespace that would end
 * it (`/`, `(`, `<`, `[`, `%`, a space…) have to be escaped `#xx` or they
 * silently truncate the dictionary — the same class of corruption this file
 * refuses everywhere else. Only the ASCII graphic range is admitted;
 * anything else is dropped rather than guessed at, and a key that survives
 * to nothing is skipped by the caller.
 */
export function pdfName(key: string): string {
  return key.replace(/[^\x21-\x7e]/g, '').replace(/[#()<>\[\]{}/%]/g, (c) =>
    `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/**
 * A PDF string.
 *
 * ASCII goes in a literal string with `(`, `)` and `\` escaped. Anything else
 * — a company name with an accent, a period rendered with an en dash — goes
 * in a UTF-16BE hex string behind a byte-order mark, which is the only
 * encoding a PDF text string can carry non-ASCII in. Writing such a name into
 * a literal string is how a reader ends up displaying mojibake for a company.
 */
export function pdfString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return `(${value.replace(/([\\()])/g, '\\$1')})`;
  }
  const utf16 = Buffer.from(`﻿${value}`, 'utf16le');
  // Node writes UTF-16 little-endian; PDF wants big-endian.
  for (let i = 0; i < utf16.length; i += 2) {
    const hi = utf16[i]!;
    utf16[i] = utf16[i + 1]!;
    utf16[i + 1] = hi;
  }
  return `<${utf16.toString('hex').toUpperCase()}>`;
}

interface Trailer {
  /** Byte offset of the xref section this trailer belongs to. */
  prev: number;
  /** `/Size` from the trailer — one past the highest object number. */
  size: number;
  /** The trailer's own entries, `/Root 61 0 R` and friends, verbatim. */
  entries: string;
  /** The object number `/Info` points at, or null when there is none. */
  infoObject: number | null;
}

function readTrailer(pdf: string): Trailer | null {
  const startxref = pdf.lastIndexOf('startxref');
  const trailerAt = pdf.lastIndexOf('trailer');
  if (startxref === -1 || trailerAt === -1 || trailerAt > startxref) return null;

  const prev = Number(/startxref\s+(\d+)/.exec(pdf.slice(startxref))?.[1]);
  const open = pdf.indexOf('<<', trailerAt);
  const close = pdf.indexOf('>>', open);
  if (!Number.isInteger(prev) || open === -1 || close === -1) return null;

  const entries = pdf.slice(open + 2, close);
  const size = Number(/\/Size\s+(\d+)/.exec(entries)?.[1]);
  if (!Number.isInteger(size)) return null;

  const info = /\/Info\s+(\d+)\s+\d+\s+R/.exec(entries);
  return { prev, size, entries, infoObject: info ? Number(info[1]) : null };
}

/** The body of `N 0 obj << … >>`, so the keys already there survive. Null when
 *  the object is not written as a plain literal — every object in a Skia PDF
 *  is, and anything else is a file this writer will not touch. */
function readObjectDictionary(pdf: string, objectNumber: number): string | null {
  const at = new RegExp(`(?:^|[\\r\\n])${objectNumber}\\s+0\\s+obj`).exec(pdf);
  if (at?.index === undefined) return null;
  const open = pdf.indexOf('<<', at.index);
  const close = pdf.indexOf('>>', open);
  const end = pdf.indexOf('endobj', at.index);
  if (open === -1 || close === -1 || end === -1 || open > end || close > end) return null;
  return pdf.slice(open + 2, close);
}

/**
 * The existing entries, minus the ones this writer is about to set.
 *
 * An escape-aware literal-string pattern rather than `[^)]*`: a
 * value containing an ESCAPED close paren — `/Producer (Skia\) x)`, which is
 * legal and which this file already preserves elsewhere — ended at the first
 * `)` and left ` x)` behind as garbage inside the new dictionary. Unreachable
 * with today's Chromium, which writes only `/Creator (Chromium)`, but
 * unreachable by luck about an upstream writer rather than by construction.
 *
 * A name is escaped into the pattern: `pdfName` admits `.`, `*`, `+` and the
 * rest of the ASCII graphic range, all of which are legal in a PDF name and
 * none of which may reach a regex unquoted.
 */
function keepExisting(dictionary: string, names: string[]): string {
  return names.reduce(
    (text, name) => text.replace(
      new RegExp(`/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\((?:\\\\.|[^\\\\()])*\\)|<[0-9A-Fa-f]*>)`, 'g'),
      '',
    ),
    dictionary,
  ).trim();
}

/**
 * What `writePdfInfoDictionary` did.
 *
 * The bytes, and whether the metadata actually reached them. It used to
 * return the buffer alone and `log.warn` when it declined, which is how
 * `capabilities.metadata` came to claim something this file cannot promise —
 * see `PdfMetadataSupport`. A caller that must know now can.
 */
export interface PdfInfoWriteResult {
  pdf: Buffer;
  written: boolean;
}

/**
 * Append `metadata` to `pdf` as a new revision of its Info dictionary.
 *
 * Returns the input unchanged, with `written: false` and a log line saying
 * why, for any file this cannot safely amend.
 */
export function writePdfInfoDictionary(pdf: Buffer, metadata: PdfMetadata): PdfInfoWriteResult {
  // latin1, so one byte is one character and every offset computed against
  // this string is a byte offset into the file. utf8 would silently shift
  // every offset past the first non-ASCII byte in a content stream.
  const text = pdf.toString('latin1');
  const trailer = readTrailer(text);
  if (trailer === null) {
    log.warn('writePdfInfoDictionary: no classic trailer, leaving the PDF unchanged', {}, 'pdf');
    return { pdf, written: false };
  }

  // A custom key whose name escapes to nothing has no name to write under.
  const custom = Object.entries(metadata.custom)
    .map(([key, value]) => [pdfName(key), value] as const)
    .filter(([name]) => name !== '');

  const objectNumber = trailer.infoObject ?? trailer.size;
  const names = [...KEYS.map(([, name]) => name), ...custom.map(([name]) => name)];
  const existing = trailer.infoObject === null
    ? ''
    : keepExisting(readObjectDictionary(text, objectNumber) ?? '', names);
  const entries = [
    ...KEYS.map(([key, name]) => `/${name} ${pdfString(metadata[key])}`),
    ...custom.map(([name, value]) => `/${name} ${pdfString(value)}`),
  ].join(' ');

  // A revision starts at the end of the file it revises.
  const body = `\n${objectNumber} 0 obj\n<< ${[existing, entries].filter(Boolean).join(' ')} >>\nendobj\n`;
  const xrefAt = pdf.length + Buffer.byteLength(body, 'latin1');
  const size = Math.max(trailer.size, objectNumber + 1);

  // One subsection, one entry: the object this revision rewrites. Its offset
  // is `pdf.length + 1` because `body` opens with the newline that separates
  // the revision from the `%%EOF` before it. Every xref entry is exactly 20
  // bytes — ten digits, a space, five digits, a space, the type, and a
  // two-byte end-of-line — and a reader that counts bytes rather than parsing
  // whitespace rejects anything else.
  const offset = `${String(pdf.length + 1).padStart(10, '0')} 00000 n \n`;
  const xref =
    `xref\n${objectNumber} 1\n${offset}` +
    `trailer\n<< ${keepTrailerEntries(trailer.entries)} /Size ${size} ` +
    `/Info ${objectNumber} 0 R /Prev ${trailer.prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return { pdf: Buffer.concat([pdf, Buffer.from(body + xref, 'latin1')]), written: true };
}

/** The previous trailer's entries with the three this revision restates
 *  removed, so `/Size`, `/Info` and `/Prev` are each written exactly once. */
function keepTrailerEntries(entries: string): string {
  return entries
    .replace(/\/Size\s+\d+/g, '')
    .replace(/\/Info\s+\d+\s+\d+\s+R/g, '')
    .replace(/\/Prev\s+\d+/g, '')
    .trim();
}
