/**
 * The MCP free-form budget sheet's parts, PARSED (MCP budget tools PR 2, review rounds 4 and 5; it replaces round 3's regex
 * scanners): workbook.xml, its rels, styles, shared strings and the sheet, each read by an XML parser (saxes, the
 * one exceljs parses with, with namespaces) after the repo's own part check (`checkXmlPart`: depth, attribute count,
 * no DOCTYPE). Only SpreadsheetML elements are read, by their exact names, and each only where SpreadsheetML puts it;
 * enumerated values (sheet state, booleans) are case-folded; anything the parser cannot read refuses the file (fail
 * closed). Server-side only; the app's template import does not use this.
 */
import { SaxesParser } from 'saxes';
import { checkXmlPart } from '@/lib/xlsxXmlScan';
import { SpreadsheetRefusedError } from '@/lib/xlsxToCsv';
import { inputError } from './gridErrors';
import { BudgetVersionError } from './budgetVersionTypes';

/** SpreadsheetML's main namespace (transitional, what Excel, Google Sheets and LibreOffice write). */
export const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

type Attrs = Readonly<Record<string, string>>;
interface Handlers {
  /** A SpreadsheetML element; `parents` are its SpreadsheetML ancestors' local names (root first). */
  open?(name: string, attrs: Attrs, parents: readonly string[]): void;
  /** `parents` ends with the element the text is in. */
  text?(text: string, parents: readonly string[]): void;
  close?(name: string, parents: readonly string[]): void;
}

export const truthy = (v: string | undefined): boolean => v !== undefined && ['1', 'true'].includes(v.trim().toLowerCase());

/** A refusal for an element the reader finds where it reads, in a place SpreadsheetML does not put it. */
export const misplaced = (what: string, name: string, parent: string): BudgetVersionError =>
  inputError(`${what}: <${name}> is not where SpreadsheetML puts it (inside <${parent}>), so IsaFlow cannot tell what a spreadsheet program shows. Open the file in Excel, save it again, and send it.`);

/**
 * Parse `part` (one xlsx part; `what` names it for a refusal) with namespaces, calling `h` for SpreadsheetML
 * elements only. Round 5: an element in any other namespace is read past only where Excel and LibreOffice write
 * such elements (a direct child of the part's root, as Excel's mc:AlternateContent absPath and xr:revisionPtr, or
 * anything inside an <extLst>), and only when nothing inside it is a SpreadsheetML element; anywhere else (in
 * <sheets>, <sheetData>, <cellXfs>, ...) it refuses the file, an mc:AlternateContent included. Unprefixed attributes
 * and r:id are read; other namespaces' attributes are not (Excel ignores them too); a SpreadsheetML-prefixed one
 * refuses. A size refusal thrown by a handler surfaces as itself.
 */
export function parseXml(part: Buffer, what: string, h: Handlers): void {
  checkXmlPart(part);
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: Array<{ name: string; main: boolean; skip: boolean; ext: boolean }> = [];
  const mainNames: string[] = [];
  let failure: unknown = null;
  const foreign = (qname: string, uri: string) => inputError(`${what}: <${qname}> is not a SpreadsheetML element (namespace "${uri.slice(0, 80)}") where IsaFlow reads the file, so it cannot tell what a spreadsheet program shows. Open the file in Excel, save it again, and send it.`);
  parser.on('error', (e) => { failure ??= e; });
  parser.on('opentag', (node) => {
    const parent = stack.at(-1);
    const main = node.uri === MAIN_NS;
    if (parent === undefined && !main) throw foreign(node.name, node.uri);
    if (parent?.ext) { stack.push({ name: node.local, main, skip: true, ext: true }); return; } // extension data: read past
    if (parent?.skip) {
      if (main) throw foreign(stack.find((e) => e.skip)!.name, 'a foreign element holding SpreadsheetML ones');
      stack.push({ name: node.local, main, skip: true, ext: false });
      return;
    }
    if (!main) {
      if (stack.length !== 1) throw foreign(node.name, node.uri);
      stack.push({ name: node.name, main, skip: true, ext: false });
      return;
    }
    const attrs: Record<string, string> = {};
    for (const a of Object.values(node.attributes)) {
      if (a.uri === '') attrs[a.local] = a.value;
      else if (a.uri === REL_NS && a.local === 'id') attrs['r:id'] = a.value;
      else if (a.uri === MAIN_NS) throw inputError(`${what}: the attribute ${a.name.slice(0, 40)} is written in a way no spreadsheet program writes. Open the file in Excel, save it again, and send it.`);
    }
    if (node.local === 'extLst') { stack.push({ name: node.local, main, skip: true, ext: true }); return; }
    h.open?.(node.local, attrs, mainNames);
    stack.push({ name: node.local, main, skip: false, ext: false });
    mainNames.push(node.local);
  });
  parser.on('closetag', () => {
    const top = stack.pop()!;
    if (top.skip) return;
    mainNames.pop();
    h.close?.(top.name, mainNames);
  });
  const text = (t: string) => { if (!stack.at(-1)?.skip) h.text?.(t, mainNames); };
  parser.on('text', text);
  parser.on('cdata', text);
  try {
    parser.write(part.toString('utf8').replace(/^\uFEFF/, '')).close();
  } catch (err) {
    if (err instanceof BudgetVersionError || err instanceof SpreadsheetRefusedError) throw err; // a handler's own refusal, as itself
    failure ??= err;
  }
  if (failure) throw inputError(`${what} is not XML IsaFlow can read. Open the file in Excel, save it again, and send it.`);
}

export interface WorkbookXml {
  sheets: Array<{ name: string; state: string; rid: string | null }>;
  /** The sheet Excel opens on (the first workbookView's activeTab; 0 when absent). */
  activeTab: number;
  date1904: boolean;
}

export function parseWorkbookXml(part: Buffer): WorkbookXml {
  const what = 'The workbook part (xl/workbook.xml)';
  const out: WorkbookXml = { sheets: [], activeTab: 0, date1904: false };
  let views = 0;
  parseXml(part, what, {
    open(name, a, parents) {
      const parent = parents.at(-1);
      if (parent === 'sheets' && name !== 'sheet') throw misplaced(what, name, parent);
      if (parent === 'bookViews' && name !== 'workbookView') throw misplaced(what, name, parent);
      if (name === 'sheet' && parent === 'sheets') out.sheets.push({ name: a.name ?? '', state: (a.state ?? 'visible').trim().toLowerCase(), rid: a['r:id'] ?? null });
      else if (name === 'workbookView' && parent === 'bookViews' && views++ === 0 && a.activeTab !== undefined) {
        if (!/^\d{1,5}$/.test(a.activeTab)) throw inputError(`The workbook's open sheet (activeTab "${a.activeTab.slice(0, 20)}") is not a sheet number.`);
        out.activeTab = Number(a.activeTab);
      } else if (name === 'workbookPr') out.date1904 = truthy(a.date1904);
    },
  });
  return out;
}

/** The rels' relationships by id: target and type. */
export function parseRels(part: Buffer | null): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  if (part) relsXml(part, out);
  return out;
}

/** Each cell style's number format: built-in id, and its code when the styles part defines one. */
export type FormatOf = (style: number) => { id: number; code: string | undefined } | null;

const STYLE_ID = /^\d{1,9}$/;
const FIRST_CUSTOM_FORMAT = 164;

export function parseStyles(part: Buffer | null): FormatOf {
  if (!part) return (s) => (s === 0 ? { id: 0, code: undefined } : null);
  const what = 'The styles part';
  const codes = new Map<number, string>();
  const xfs: number[] = [];
  parseXml(part, what, {
    open(name, a, parents) {
      const parent = parents.at(-1);
      if (parent === 'numFmts' && name !== 'numFmt') throw misplaced(what, name, parent);
      if (parent === 'cellXfs' && name !== 'xf') throw misplaced(what, name, parent);
      if (name === 'numFmt' && parent === 'numFmts') {
        if (!STYLE_ID.test(a.numFmtId ?? '')) throw inputError(`${what} names a number format that is not a number.`);
        const id = Number(a.numFmtId);
        if (id < FIRST_CUSTOM_FORMAT) throw inputError(`${what} redefines built-in number format ${id}, which no spreadsheet program writes. Open the file in Excel, save it again, and send it.`);
        if (codes.has(id)) throw inputError(`${what} defines number format ${id} twice.`);
        codes.set(id, a.formatCode ?? '');
      } else if (name === 'xf' && parent === 'cellXfs') {
        if (!STYLE_ID.test(a.numFmtId ?? '0')) throw inputError(`${what} names a number format that is not a number.`);
        xfs.push(Number(a.numFmtId ?? 0));
      }
    },
  });
  return (s) => {
    if (xfs.length === 0) return s === 0 ? { id: 0, code: undefined } : null;
    const id = xfs[s];
    return id === undefined ? null : { id, code: codes.get(id) };
  };
}

/** The shared strings (phonetic runs left out), at most `max` of them. */
const SST_CHILDREN: Readonly<Record<string, readonly string[]>> = { sst: ['si'], si: ['t', 'r', 'rPh', 'phoneticPr'], r: ['rPr', 't'], rPh: ['t'] };

export function parseSharedStrings(part: Buffer | null, max: number): string[] {
  const out: string[] = [];
  if (!part) return out;
  const what = 'The shared strings part';
  parseXml(part, what, {
    open(name, _a, parents) {
      const parent = parents.at(-1);
      if (parent !== undefined && SST_CHILDREN[parent] && !SST_CHILDREN[parent]!.includes(name)) throw misplaced(what, name, parent);
      if (name === 'si' && parent === 'sst') {
        if (out.length >= max) throw inputError(`This workbook holds more than ${max} different texts. Split the file and send each part.`);
        out.push('');
      }
    },
    text(t, parents) {
      const at = parents.at(-1), above = parents.at(-2);
      if (at === 't' && (above === 'si' || (above === 'r' && parents.at(-3) === 'si'))) out[out.length - 1] += t;
    },
  });
  return out;
}

function relsXml(part: Buffer, out: Map<string, { target: string; type: string }>): void {
  const parser = new SaxesParser({ xmlns: false, position: false });
  let failure: unknown = null;
  parser.on('error', (e) => { failure ??= e; });
  parser.on('opentag', (node) => {
    const a = node.attributes as Record<string, string>;
    if (node.name === 'Relationship' && a.Id && a.Target && !out.has(a.Id)) out.set(a.Id, { target: a.Target, type: a.Type ?? '' });
  });
  checkXmlPart(part);
  try { parser.write(part.toString('utf8').replace(/^\uFEFF/, '')).close(); } catch (err) { failure ??= err; }
  if (failure) throw inputError('The workbook\'s relationships part is not XML IsaFlow can read. Open the file in Excel, save it again, and send it.');
}

/** Built-in formats that are plain numbers: 0 General, 1-4, 37-40, and the accounting 41 / 43 (no currency symbol). */
const PLAIN_BUILTIN = new Set([0, 1, 2, 3, 4, 37, 38, 39, 40, 41, 43]);
const COLOUR = /\[(?:black|blue|cyan|green|magenta|red|white|yellow|color ?\d{1,2})\]/gi;
const RAND = /\[\$R(?:-[0-9a-f]{1,8})?\]/gi;

/**
 * An ALLOWLIST (round 5, tightened): General, or up to four sections, none empty (so nothing is hidden), with NO
 * quoted or escaped literal text, no condition and no locale or other [...] code but a colour or the rand symbol
 * ([$R-1C09], [$R], or a bare R, at most once a section). A number section holds only digit placeholders (0 # ?),
 * `,` between placeholders (never a scaling comma), at most one `.`, spaces and `_` / `*` padding; the negative
 * section shows its sign (`-` or parentheses); the positive and zero sections show none; a fourth (text) section is
 * `@` alone. Built-in ids only 0-4, 37-40, 41 and 43.
 */
export function isPlainNumberFormat(id: number, code: string | undefined): boolean {
  if (code === undefined) return PLAIN_BUILTIN.has(id);
  if (/^\s*general\s*$/i.test(code)) return true;
  if (/["\\]/.test(code)) return false;
  const sections = code.split(';');
  if (sections.length > 4 || sections.some((sec) => sec.trim() === '')) return false;
  return sections.every((section, i) => {
    const bare = section.replace(/[_*]./gs, '').replace(COLOUR, '').replace(RAND, 'R');
    if (bare.includes('[')) return false;
    if (i === 3) return /^\s*@\s*$/.test(bare);
    if (!/[0#?]/.test(bare) || !/^[0#?,.\s()\-R]*$/.test(bare)) return false;
    if (bare.replace(/(?<=[0#?]),(?=[0#?])/g, '').includes(',')) return false;
    if ((bare.match(/\./g) ?? []).length > 1 || (bare.match(/R/g) ?? []).length > 1) return false;
    const signed = /[-()]/.test(bare);
    return i === 1 ? signed : !signed;
  });
}

/** An Excel date serial as YYYY-MM-DD (the 1900 or 1904 system), or null. */
export function serialDate(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}
