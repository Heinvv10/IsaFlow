/**
 * Rebuild an uploaded .xlsx as a small, trusted zip before anything parses it.
 *
 * Two zip parsers reading the same upload is a parser differential: jszip reads
 * the central directory, ExcelJS's streaming reader walks the local entries
 * from the front, and a crafted zip can show each a different file. So the
 * upload is read ONCE, by jszip, and every entry the conversion needs is
 * inflated with its bytes counted against one budget (the sizes a zip declares
 * can lie). Those bytes are written into a fresh zip, stored uncompressed and
 * in the order ExcelJS needs them (rels, workbook, styles, shared strings, then
 * the sheets as `xl/worksheets/sheet1.xml`, `sheet2.xml`, ...), and only that
 * zip reaches ExcelJS. Shared strings and rels always precede the sheets (an
 * empty table or rel list is written when the upload has none), so the
 * streaming reader never defers a sheet to a temp file.
 *
 * workbook.xml and its rels are capped (STRUCTURE_MAX_BYTES) before any regex
 * reads them, and the tag regexes are bounded, so a run of unclosed tags costs
 * linear time. A zip jszip cannot read, or an entry that will not inflate, is
 * SpreadsheetMalformedError (a 400), never a crash.
 *
 * Server-side only.
 */
import JSZip from 'jszip';
import { SpreadsheetMalformedError, SpreadsheetTooLargeError } from './spreadsheetErrors';

const EMPTY_SHARED_STRINGS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>';
const EMPTY_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

/** workbook.xml and workbook.xml.rels: far beyond what any spreadsheet program writes. */
const STRUCTURE_MAX_BYTES = 256 * 1024;
const SHEET_TAG = /<(?:[\w.-]{1,64}:)?sheet\b[^>]{0,2048}>/g;
const RELATIONSHIP_TAG = /<(?:[\w.-]{1,64}:)?Relationship\b[^>]{0,2048}>/g;
const ATTRIBUTE = /\s([\w:.-]{1,256})\s*=\s*"([^"]*)"/g;

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
const tooLarge = (maxBytes: number) => new SpreadsheetTooLargeError(
  `This workbook is too large to import (over ${mb(maxBytes)} MB once opened). Save the sheet you need as CSV, or split it, and upload again.`,
);
const notAWorkbook = () => new SpreadsheetMalformedError('This file is not an Excel workbook (.xlsx), or it is damaged. Save it as .xlsx or CSV and upload again.');

/** What is left of one byte limit, and the refusal past it. */
interface Budget { left: number; refuse: () => Error }

/** Inflate one entry, counting against every budget given; stops at the first byte past any of them. */
function inflate(file: JSZip.JSZipObject, budgets: readonly Budget[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (err: Error) => { if (!settled) { settled = true; chunks.length = 0; reject(err); } };
    let stream: ReturnType<JSZip.JSZipObject['nodeStream']>;
    try {
      stream = file.nodeStream('nodebuffer');
    } catch {
      return fail(notAWorkbook());
    }
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      for (const b of budgets) b.left -= chunk.length;
      const over = budgets.find((b) => b.left < 0);
      if (over) {
        stream.pause();
        stream.removeAllListeners('data');
        return fail(over.refuse());
      }
      chunks.push(chunk);
    });
    stream.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    stream.on('error', () => fail(notAWorkbook()));
  });
}

/** The attributes of one XML start tag, by local name (`r:id` → `id`). */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTRIBUTE)) out[m[1]!.replace(/^[\w.-]+:/, '')] = m[2]!;
  return out;
}

/**
 * A named sheet's rels target as a zip path, or null. Only `worksheets/<file>.xml` relative to
 * `xl/` (what Excel and ExcelJS write), or the same written absolute as `/xl/worksheets/<file>.xml`
 * (Google Sheets, openpyxl), is taken: no `..`, nothing outside `xl/worksheets/`, so a crafted rels
 * entry cannot point the read at another part.
 */
const NAMED_SHEET_TARGET = /^(?:\.\/|\/xl\/)?worksheets\/[\w-]+(?:\.[\w-]+)*\.xml$/;
function namedSheetPart(target: string): string | null {
  return NAMED_SHEET_TARGET.test(target) ? `xl/${target.replace(/^(?:\.\/|\/xl\/)/, '')}` : null;
}

interface Workbook {
  zip: JSZip;
  budget: Budget;
  read: (path: string, extra?: readonly Budget[]) => Promise<Buffer | null>;
  workbook: Buffer;
  rels: Buffer | null;
  /** The sheets in workbook order: name and rels target (null when the rels do not say). */
  sheets: Array<{ name: string | undefined; target: string | null }>;
}

/** The upload's central directory, workbook.xml and its rels (each capped), and its sheet list. */
async function openWorkbook(buf: Buffer, maxBytes: number): Promise<Workbook> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf); // the central directory only; nothing is inflated yet
  } catch {
    throw notAWorkbook();
  }
  const budget: Budget = { left: maxBytes, refuse: () => tooLarge(maxBytes) };
  const read = async (path: string, extra: readonly Budget[] = []): Promise<Buffer | null> => {
    const file = zip.file(path);
    return file && !file.dir ? inflate(file, [budget, ...extra]) : null;
  };
  const structure = (): Budget => ({
    left: STRUCTURE_MAX_BYTES,
    refuse: () => new SpreadsheetTooLargeError('This workbook\'s sheet list is larger than any spreadsheet program writes. Open it in Excel, save it again, and upload it.'),
  });
  const workbook = await read('xl/workbook.xml', [structure()]);
  if (!workbook) throw notAWorkbook();
  const rels = await read('xl/_rels/workbook.xml.rels', [structure()]);
  const targets = new Map<string, string>();
  for (const m of (rels?.toString('utf8') ?? '').matchAll(RELATIONSHIP_TAG)) {
    const a = attributes(m[0]);
    if (a.Id && a.Target && !targets.has(a.Id)) targets.set(a.Id, a.Target);
  }
  const sheets = [...workbook.toString('utf8').matchAll(SHEET_TAG)].map((m) => {
    const a = attributes(m[0]);
    return { name: a.name, target: (a.id && targets.get(a.id)) ?? null };
  });
  return { zip, budget, read, workbook, rels, sheets };
}

/** The lowest-numbered sheet, when the workbook does not name its first. */
function lowestSheetPath(zip: JSZip): string | null {
  const sheets = Object.keys(zip.files)
    .map(p => ({ p, n: /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(p)?.[1] }))
    .filter((s): s is { p: string; n: string } => s.n !== undefined)
    .sort((a, b) => Number(a.n) - Number(b.n));
  return sheets[0]?.p ?? null;
}

/** The normalised zip: the structure parts, then `sheets` as sheet1..n. */
function pack(wb: Workbook, styles: Buffer | null, shared: Buffer | null, sheets: readonly Buffer[]): Promise<Buffer> {
  const out = new JSZip();
  out.file('xl/_rels/workbook.xml.rels', wb.rels ?? EMPTY_RELS);
  out.file('xl/workbook.xml', wb.workbook);
  if (styles) out.file('xl/styles.xml', styles);
  out.file('xl/sharedStrings.xml', shared ?? EMPTY_SHARED_STRINGS);
  sheets.forEach((sheet, i) => out.file(`xl/worksheets/sheet${i + 1}.xml`, sheet));
  return out.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

/**
 * The normalised zip of the workbook's first sheet, or null when it has none. Throws
 * SpreadsheetTooLargeError past `maxBytes` inflated, SpreadsheetMalformedError when it is not a
 * workbook at all.
 */
export async function normaliseXlsx(buf: Buffer, maxBytes: number): Promise<Buffer | null> {
  const wb = await openWorkbook(buf, maxBytes);
  const target = wb.sheets[0]?.target;
  const named = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : null;
  const path = named && wb.zip.file(named) ? named : lowestSheetPath(wb.zip);
  if (!path) return null;
  const styles = await wb.read('xl/styles.xml');
  const shared = await wb.read('xl/sharedStrings.xml');
  const sheet = await wb.read(path);
  return sheet ? pack(wb, styles, shared, [sheet]) : null;
}

export interface NormaliseOptions {
  /** Everything inflated, all parts together. */
  maxBytes: number;
  /** The shared-strings part, inflated (also counted in `maxBytes`). */
  maxSharedStringsBytes?: number;
  /** Shared-string entries (`<si>`), counted in the inflated part, never taken from its header. */
  maxSharedStrings?: number;
}

export interface NormalisedSheets {
  zip: Buffer;
  /** The names found, in the order asked: `sheets[i]` is `xl/worksheets/sheet${i + 1}.xml`. */
  sheets: string[];
}

/** Shared-string entries in an inflated sst part: `<si>`, `<si ...>` and `<si/>`. */
function countEntries(xml: Buffer): number {
  let n = 0;
  for (let at = xml.indexOf('<si'); at >= 0; at = xml.indexOf('<si', at + 3)) {
    const next = xml[at + 3];
    if (next === 0x3e || next === 0x2f || next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d) n++;
  }
  return n;
}

/**
 * The sheets called `names` (matched as written in workbook.xml, hidden sheets included, each
 * resolved through the rels by its `r:id`), read in ONE pass with one shared-strings part and one
 * budget. A name the workbook does not have, or whose target is not a plain worksheet part, is
 * left out of `sheets`. Throws as normaliseXlsx, and SpreadsheetTooLargeError past a shared-strings
 * limit.
 */
export async function normaliseXlsxSheets(buf: Buffer, names: readonly string[], opts: NormaliseOptions): Promise<NormalisedSheets> {
  const wb = await openWorkbook(buf, opts.maxBytes);
  const found: Array<{ name: string; path: string }> = [];
  for (const name of names) {
    const target = wb.sheets.find((s) => s.name === name)?.target;
    const path = target ? namedSheetPart(target) : null;
    if (path && wb.zip.file(path)) found.push({ name, path });
  }
  const styles = await wb.read('xl/styles.xml');
  const sstLimit = opts.maxSharedStringsBytes;
  const shared = await wb.read('xl/sharedStrings.xml', sstLimit === undefined ? [] : [{
    left: sstLimit,
    refuse: () => new SpreadsheetTooLargeError(`This workbook holds more than ${mb(sstLimit)} MB of text. Split the file and upload each part.`),
  }]);
  if (shared && opts.maxSharedStrings !== undefined && countEntries(shared) > opts.maxSharedStrings) {
    throw new SpreadsheetTooLargeError(`This workbook holds more than ${opts.maxSharedStrings} different texts. Split the file and upload each part.`);
  }
  const sheets: Buffer[] = [];
  for (const f of found) sheets.push((await wb.read(f.path))!);
  return { zip: await pack(wb, styles, shared, sheets), sheets: found.map((f) => f.name) };
}
