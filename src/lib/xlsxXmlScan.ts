/**
 * Linear checks on the XML parts of an uploaded workbook, run by xlsxNormalise on every part it
 * passes to ExcelJS, and the guard around ExcelJS's own read. Server-side only.
 *
 * ExcelJS's SAX parser keeps a stack per open element, so a sheet of three million unclosed `<x>`
 * tags (a 16 KB upload) cost 10-33 s and up to 3 GB before it failed. `checkXmlPart` walks the
 * bytes once, with no regex and no parse, and refuses nesting deeper than MAX_XML_DEPTH and any
 * DOCTYPE (entity declarations: no workbook part has one). `readNormalised` turns anything the
 * parser throws into SpreadsheetMalformedError with a neutral message; the parser's own text,
 * which echoes the upload, is logged, never answered.
 */
import { log } from './logger';
import { SpreadsheetMalformedError, SpreadsheetRefusedError } from './spreadsheetErrors';

/**
 * Deeper than any part Excel writes: the deepest found is a worksheet's control markup
 * (`mc:AlternateContent` > ... > `xdr:col`, 11), and a sheet's cells sit at 4.
 */
export const MAX_XML_DEPTH = 24;

const LT = 0x3c, GT = 0x3e, SLASH = 0x2f, QUESTION = 0x3f, BANG = 0x21, DQUOTE = 0x22, SQUOTE = 0x27;

const malformed = () => new SpreadsheetMalformedError('This workbook\'s XML is not what a spreadsheet program writes. Open it in Excel, save it again, and upload it.');

/** Index just past `end` from `from`, or refuse when the part ends first. */
function past(xml: Buffer, end: string, from: number): number {
  const at = xml.indexOf(end, from);
  if (at < 0) throw malformed();
  return at + end.length;
}

/** Refuse a part nested past MAX_XML_DEPTH, closing more than it opens, or holding a DOCTYPE. One pass. */
export function checkXmlPart(xml: Buffer): void {
  let depth = 0;
  let i = xml.indexOf(LT);
  while (i >= 0) {
    const next = xml[i + 1];
    let end: number;
    if (next === SLASH) {
      end = past(xml, '>', i);
      if (--depth < 0) throw malformed();
    } else if (next === QUESTION) {
      end = past(xml, '?>', i);
    } else if (next === BANG) {
      if (xml.subarray(i, i + 4).toString('latin1') === '<!--') end = past(xml, '-->', i + 4);
      else if (xml.subarray(i, i + 9).toString('latin1') === '<![CDATA[') end = past(xml, ']]>', i + 9);
      else throw malformed(); // <!DOCTYPE, <!ENTITY
    } else {
      // A start tag: its end is the first '>' outside a quoted attribute value.
      let j = i + 1, quote = 0;
      for (; j < xml.length; j++) {
        const b = xml[j];
        if (quote) { if (b === quote) quote = 0; } else if (b === DQUOTE || b === SQUOTE) quote = b; else if (b === GT) break;
      }
      if (j >= xml.length) throw malformed();
      if (xml[j - 1] !== SLASH && ++depth > MAX_XML_DEPTH) throw malformed();
      end = j + 1;
    }
    i = xml.indexOf(LT, end);
  }
}

/** Run an ExcelJS read of a normalised zip; a parser failure is SpreadsheetMalformedError (a 400), its text logged only. */
export async function readNormalised<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof SpreadsheetRefusedError) throw err;
    log.warn('Spreadsheet refused: the parser failed on it', { error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : String(err).slice(0, 200) }, 'spreadsheet');
    throw new SpreadsheetMalformedError('This workbook could not be read: it is damaged or was not written by a spreadsheet program. Open it in Excel, save it again, and upload it.');
  }
}
