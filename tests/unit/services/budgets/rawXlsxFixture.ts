/**
 * Workbooks written as raw XML (no spreadsheet library in between), so a test can hold exactly the forms a hand-edited
 * or crafted file has: single-quoted attributes, long tags, lower-case or $-anchored refs, odd sheet names and states,
 * hidden rows and columns, merges, number formats by id or code. Used by the free-form budget reader's tests.
 */
import JSZip from 'jszip';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface RawSheet {
  /** Written into name="..." verbatim (entities and all). */
  name: string;
  /** Written after the name verbatim, e.g. ` state='hidden'`. */
  attrs?: string;
  /** The worksheet's whole body (inside <worksheet>). */
  body: string;
}

export interface RawBook {
  sheets: RawSheet[];
  /** workbookView activeTab; omitted when undefined. */
  activeTab?: number;
  /** The styles part's body (inside <styleSheet>); no styles part when undefined. */
  styles?: string;
  /** Shared strings; no part when undefined. */
  sst?: string[];
  /** workbook.xml's whole body (inside <workbook>), replacing the one built from `sheets` and `activeTab`. */
  workbookBody?: string;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export async function rawBook(b: RawBook): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const view = b.activeTab === undefined ? '' : `<bookViews><workbookView activeTab="${b.activeTab}"/></bookViews>`;
  const sheetsXml = `<sheets>${b.sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.attrs ?? ''} r:id="rId${i + 1}"/>`).join('')}</sheets>`;
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}>${b.workbookBody ?? `${view}${sheetsXml}`}</workbook>`);
  const rels = b.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  if (b.styles !== undefined) rels.push(`<Relationship Id="rId90" Type="${REL}/styles" Target="styles.xml"/>`);
  if (b.sst !== undefined) rels.push(`<Relationship Id="rId91" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  b.sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}>${s.body}</worksheet>`));
  if (b.styles !== undefined) zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}>${b.styles}</styleSheet>`);
  if (b.sst !== undefined) zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst ${NS} count="${b.sst.length}">${b.sst.map((t) => `<si><t>${esc(t)}</t></si>`).join('')}</sst>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Column letters of a 0-based index. */
export const colOf = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));

/** One cell: text inline, a number (with an optional style index), or `raw` XML verbatim. */
export type RawCellSpec = string | number | { raw: string } | { n: number; s: number } | null;

export function rowXml(r: number, cells: readonly RawCellSpec[], attrs = ''): string {
  return `<row r="${r}"${attrs}>${cells.map((c, i) => {
    const ref = `${colOf(i)}${r}`;
    if (c === null) return '';
    if (typeof c === 'string') return `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`;
    if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
    if ('raw' in c) return c.raw.replace('$REF', ref);
    return `<c r="${ref}" s="${c.s}"><v>${c.n}</v></c>`;
  }).join('')}</row>`;
}

/** A sheet body: <sheetData> of `rows`, `before` and `after` it. */
export const sheetBody = (rows: string, after = '', before = ''): string => `${before}<sheetData>${rows}</sheetData>${after}`;

/** A styles body whose cellXfs are the given numFmtIds in order (index 0 first), with `numFmts` custom codes. */
export function stylesWith(xfs: readonly number[], numFmts: Record<number, string> = {}): string {
  const fmts = Object.entries(numFmts).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}"/>`).join('');
  return `${fmts ? `<numFmts count="${Object.keys(numFmts).length}">${fmts}</numFmts>` : ''}<cellXfs count="${xfs.length}">${xfs.map((id) => `<xf numFmtId="${id}"/>`).join('')}</cellXfs>`;
}
