/**
 * Linear checks on the XML parts of an uploaded workbook, run by xlsxNormalise on every part it
 * passes to ExcelJS, and the guards around ExcelJS's own read. Server-side only.
 *
 * ExcelJS's SAX parser (saxes) keeps a stack per open element, and on a fault it records an error
 * and carries on: a sheet of three million unclosed `<x>` tags (a 16 KB upload) cost 10-33 s and
 * up to 3 GB; `<x></>` x 3.2M cost 19.8 s and 1.5 GB; 3M duplicate attributes on one tag, 10 s.
 * `checkXmlPart` walks the bytes once, with no regex and no parse, keeping the names of the open
 * elements: it refuses nesting deeper than MAX_XML_DEPTH, a close tag that does not name the
 * element it closes (empty included), a part that ends with elements open, a duplicate attribute
 * name or more than MAX_XML_ATTRIBUTES attributes on one element, and any DOCTYPE (entity
 * declarations: no workbook part has one). What the scan does not read (entities, characters) is
 * left to the parser, which `readerInput` makes stop at its first error: the normalised zip is fed
 * in READ_CHUNK_BYTES pieces, and ExcelJS throws a parser error after each piece it parsed.
 * `readNormalised` turns anything the parser throws into SpreadsheetMalformedError with a neutral
 * message; only the error's class and line:column are logged, never its text (which can quote the
 * upload).
 */
import { Readable } from 'node:stream';
import { log } from './logger';
import { SpreadsheetMalformedError, SpreadsheetRefusedError } from './spreadsheetErrors';

/**
 * Deeper than any part Excel writes: the deepest found is a worksheet's control markup
 * (`mc:AlternateContent` > ... > `xdr:col`, 11), and a sheet's cells sit at 4.
 */
export const MAX_XML_DEPTH = 24;
/** Far more than any element has: a worksheet root's namespace declarations are the most, ~15. */
export const MAX_XML_ATTRIBUTES = 100;
/** The pieces ExcelJS is fed: a parser error costs at most this much more parsing. */
export const READ_CHUNK_BYTES = 64 * 1024;

const LT = 0x3c, GT = 0x3e, SLASH = 0x2f, QUESTION = 0x3f, BANG = 0x21, DQUOTE = 0x22, SQUOTE = 0x27, EQ = 0x3d;
const isSpace = (b: number | undefined) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

const malformed = () => new SpreadsheetMalformedError('This workbook\'s XML is not what a spreadsheet program writes. Open it in Excel, save it again, and upload it.');

/** Index just past `end` from `from`, or refuse when the part ends first. */
function past(xml: Buffer, end: string, from: number): number {
  const at = xml.indexOf(end, from);
  if (at < 0) throw malformed();
  return at + end.length;
}

/** Index of the first byte at or after `j` that is space, `/`, `>` or `=` (the end of a name). */
function nameEnd(xml: Buffer, j: number): number {
  while (j < xml.length) {
    const b = xml[j];
    if (isSpace(b) || b === SLASH || b === GT || b === EQ) break;
    j++;
  }
  return j;
}

function skipSpace(xml: Buffer, j: number): number {
  while (isSpace(xml[j])) j++;
  return j;
}

/**
 * The start tag at `i` (`<name attr="v" ...>` or `.../>`): its name, whether it closes itself and
 * the index past its `>`. Refuses a tag that is cut off, an attribute without `="..."`, a
 * duplicate attribute name, or more than MAX_XML_ATTRIBUTES attributes.
 */
function startTag(xml: Buffer, i: number): { name: string; selfClosing: boolean; end: number } {
  let j = nameEnd(xml, i + 1);
  const name = xml.toString('utf8', i + 1, j);
  if (name === '') throw malformed();
  const seen = new Set<string>();
  for (;;) {
    j = skipSpace(xml, j);
    const b = xml[j];
    if (b === GT) return { name, selfClosing: false, end: j + 1 };
    if (b === SLASH) {
      if (xml[j + 1] !== GT) throw malformed();
      return { name, selfClosing: true, end: j + 2 };
    }
    if (b === undefined) throw malformed();
    const at = j;
    j = nameEnd(xml, j);
    const attr = xml.toString('utf8', at, j);
    if (attr === '' || seen.has(attr) || seen.size >= MAX_XML_ATTRIBUTES) throw malformed();
    seen.add(attr);
    j = skipSpace(xml, j);
    if (xml[j] !== EQ) throw malformed();
    j = skipSpace(xml, j + 1);
    const quote = xml[j];
    if (quote !== DQUOTE && quote !== SQUOTE) throw malformed();
    const close = xml.indexOf(quote, j + 1);
    if (close < 0) throw malformed();
    j = close + 1;
  }
}

/**
 * Refuse a part that is not well-formed in the ways the parser would only report and carry on
 * from (see the file comment), nested past MAX_XML_DEPTH, or holding a DOCTYPE. One pass.
 */
export function checkXmlPart(xml: Buffer): void {
  const open: string[] = [];
  let i = xml.indexOf(LT);
  while (i >= 0) {
    const next = xml[i + 1];
    let end: number;
    if (next === SLASH) {
      const gt = xml.indexOf(GT, i);
      if (gt < 0) throw malformed();
      let k = gt;
      while (k > i + 2 && isSpace(xml[k - 1])) k--;
      const name = xml.toString('utf8', i + 2, k);
      if (name === '' || open.pop() !== name) throw malformed();
      end = gt + 1;
    } else if (next === QUESTION) {
      end = past(xml, '?>', i);
    } else if (next === BANG) {
      if (xml.subarray(i, i + 4).toString('latin1') === '<!--') end = past(xml, '-->', i + 4);
      else if (xml.subarray(i, i + 9).toString('latin1') === '<![CDATA[') end = past(xml, ']]>', i + 9);
      else throw malformed(); // <!DOCTYPE, <!ENTITY
    } else {
      const tag = startTag(xml, i);
      if (!tag.selfClosing) {
        open.push(tag.name);
        if (open.length > MAX_XML_DEPTH) throw malformed();
      }
      end = tag.end;
    }
    i = xml.indexOf(LT, end);
  }
  if (open.length > 0) throw malformed();
}

/** Bytes the cutter has looked at, ever (tests assert it stays linear in the input). */
let inspected = 0;
export const readerInputInspected = (): number => inspected;

/**
 * Where the piece starting at `start` ends: just after the last `>` within READ_CHUNK_BYTES (ASCII,
 * so never inside a character), else at the last UTF-8 character start in reach (stepping back
 * over at most 3 continuation bytes 10xxxxxx), else at the full length (no character starts there:
 * zip binary). ExcelJS decodes each piece on its own, so a character cut in two would read as
 * U+FFFD (U8). Both searches stay inside the piece: one that ran back past `start` made a long
 * stretch with no `>` quadratic (round 5).
 */
function pieceEnd(zip: Buffer, start: number): number {
  const end = Math.min(start + READ_CHUNK_BYTES, zip.length);
  if (end === zip.length) return end;
  for (let i = end - 1; i >= start; i--) {
    inspected++;
    if (zip[i] === GT) return i + 1;
  }
  let cut = end;
  for (let k = 0; k < 3 && cut > start && ((zip[cut] ?? 0) & 0xc0) === 0x80; k++) { inspected++; cut--; }
  return cut > start ? cut : end;
}

/**
 * The normalised zip as ExcelJS's input, in pieces of at most READ_CHUNK_BYTES so a parser error
 * stops the read within one piece, each cut where no character is split (`pieceEnd`).
 */
export function readerInput(zip: Buffer): Readable {
  return Readable.from((function* pieces() {
    for (let at = 0; at < zip.length;) {
      const end = pieceEnd(zip, at);
      yield zip.subarray(at, end);
      at = end;
    }
  })());
}

/** Run an ExcelJS read of a normalised zip; a parser failure is SpreadsheetMalformedError (a 400), its text logged only. */
export async function readNormalised<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof SpreadsheetRefusedError) throw err;
    // The error's class and the parser's line:column only: its message can quote the upload.
    const position = err instanceof Error ? (/^(\d+:\d+):/.exec(err.message)?.[1] ?? null) : null;
    log.warn('Spreadsheet refused: the parser failed on it', { errorClass: err instanceof Error ? err.name : typeof err, position }, 'spreadsheet');
    throw new SpreadsheetMalformedError('This workbook could not be read: it is damaged or was not written by a spreadsheet program. Open it in Excel, save it again, and upload it.');
  }
}
