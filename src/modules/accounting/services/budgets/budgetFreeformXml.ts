/**
 * The MCP free-form budget sheet's parts, PARSED (MCP budget tools PR 2, review round 4; it replaces round 3's regex
 * scanners): workbook.xml, its rels, styles, shared strings and the sheet, each read by an XML parser (saxes, the
 * one exceljs parses with) after the repo's own part check (`checkXmlPart`: depth, attribute count, no DOCTYPE).
 * Element and attribute names are compared by local name, case-folded; enumerated values (sheet state, cell type,
 * booleans) case-folded; anything the parser cannot read refuses the file (fail closed). Server-side only; the
 * app's template import does not use this.
 */
import { SaxesParser } from 'saxes';
import { checkXmlPart } from '@/lib/xlsxXmlScan';
import { inputError } from './gridErrors';
import { BudgetVersionError } from './budgetVersionTypes';

type Attrs = Readonly<Record<string, string>>;
interface Handlers {
  open?(name: string, attrs: Attrs, parents: readonly string[]): void;
  /** `parents` ends with the element the text is in. */
  text?(text: string, parents: readonly string[]): void;
  close?(name: string, parents: readonly string[]): void;
}

const local = (qname: string): string => qname.slice(qname.indexOf(':') + 1).toLowerCase();
export const truthy = (v: string | undefined): boolean => v !== undefined && ['1', 'true'].includes(v.trim().toLowerCase());

/** Parse `part` (one xlsx part, `what` names it for the refusal), calling `h` per element and text. */
export function parseXml(part: Buffer, what: string, h: Handlers): void {
  checkXmlPart(part);
  const parser = new SaxesParser({ position: false });
  const stack: string[] = [];
  let failure: unknown = null;
  parser.on('error', (e) => { failure ??= e; });
  parser.on('opentag', (node) => {
    const name = local(node.name);
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(node.attributes)) attrs[local(k)] = String(v);
    h.open?.(name, attrs, stack);
    stack.push(name);
  });
  parser.on('closetag', () => { const name = stack.pop()!; h.close?.(name, stack); });
  parser.on('text', (t) => h.text?.(t, stack));
  parser.on('cdata', (t) => h.text?.(t, stack));
  try {
    parser.write(part.toString('utf8').replace(/^﻿/, '')).close();
  } catch (err) {
    if (err instanceof BudgetVersionError) throw err; // a handler's own refusal, worded for the caller
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
  const out: WorkbookXml = { sheets: [], activeTab: 0, date1904: false };
  let views = 0;
  parseXml(part, 'The workbook part (xl/workbook.xml)', {
    open(name, a, parents) {
      if (name === 'sheet' && parents.at(-1) === 'sheets') out.sheets.push({ name: a.name ?? '', state: (a.state ?? 'visible').trim().toLowerCase(), rid: a.id ?? null });
      else if (name === 'workbookview' && views++ === 0 && a.activetab !== undefined) {
        const n = Number(a.activetab);
        if (!Number.isInteger(n) || n < 0) throw inputError(`The workbook's open sheet (activeTab "${a.activetab.slice(0, 20)}") is not a sheet number.`);
        out.activeTab = n;
      } else if (name === 'workbookpr') out.date1904 = truthy(a.date1904);
    },
  });
  return out;
}

/** The rels' relationships by id: target and type. */
export function parseRels(part: Buffer | null): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  if (part) parseXml(part, 'The workbook\'s relationships part', { open(name, a) { if (name === 'relationship' && a.id && a.target && !out.has(a.id)) out.set(a.id, { target: a.target, type: a.type ?? '' }); } });
  return out;
}

/** Each cell style's number format: built-in id, and its code when the styles part defines one. */
export type FormatOf = (style: number) => { id: number; code: string | undefined } | null;

export function parseStyles(part: Buffer | null): FormatOf {
  if (!part) return (s) => (s === 0 ? { id: 0, code: undefined } : null);
  const codes = new Map<number, string>();
  const xfs: number[] = [];
  parseXml(part, 'The styles part', {
    open(name, a, parents) {
      if (name === 'numfmt' && parents.at(-1) === 'numfmts') codes.set(Number(a.numfmtid), a.formatcode ?? '');
      else if (name === 'xf' && parents.at(-1) === 'cellxfs') xfs.push(Number(a.numfmtid ?? 0));
    },
  });
  if (xfs.some((id) => !Number.isInteger(id) || id < 0)) throw inputError('The styles part names a number format that is not a number.');
  return (s) => {
    if (xfs.length === 0) return s === 0 ? { id: 0, code: undefined } : null;
    const id = xfs[s];
    return id === undefined ? null : { id, code: codes.get(id) };
  };
}

/** The shared strings (phonetic runs left out), at most `max` of them. */
export function parseSharedStrings(part: Buffer | null, max: number): string[] {
  const out: string[] = [];
  if (!part) return out;
  parseXml(part, 'The shared strings part', {
    open(name, _a, parents) {
      if (name === 'si' && parents.at(-1) === 'sst') {
        if (out.length >= max) throw inputError(`This workbook holds more than ${max} different texts. Split the file and send each part.`);
        out.push('');
      }
    },
    text(t, parents) { if (parents.at(-1) === 't' && parents.includes('si') && !parents.includes('rph')) out[out.length - 1] += t; },
  });
  return out;
}

/** Built-in number formats that are plain numbers, currency or accounting (Excel's ids: 0 General, 1-8, 37-44). */
const PLAIN_BUILTIN = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 37, 38, 39, 40, 41, 42, 43, 44]);
const COLOUR = /\[(?:black|blue|cyan|green|magenta|red|white|yellow|color ?\d{1,2})\]/gi;
const RAND = /\[\$R(?:-[0-9a-f]{1,8})?\]/gi;

/**
 * An ALLOWLIST: General, or a code made only of digit placeholders (0 # ?), digits, `,` `.` spaces, the R currency
 * symbol (also as [$R-...]), quoted or escaped literal text, `_` / `*` padding, sections (`;`, parentheses, `-`),
 * colour codes and the text placeholder `@`; with at least one digit placeholder. Every date, time, locale-calendar,
 * percent, scientific, fraction, conditional or locale format is outside it, and so is every built-in id outside the
 * plain set (the CJK dates 27-36 and 50-58 among them).
 */
export function isPlainNumberFormat(id: number, code: string | undefined): boolean {
  if (code === undefined) return PLAIN_BUILTIN.has(id);
  const c = code.trim();
  if (/^general$/i.test(c)) return true;
  const bare = c.replace(/"[^"]*"/g, '').replace(/\\./gs, '').replace(/[_*]./gs, '').replace(COLOUR, '').replace(RAND, 'R');
  return /[0#?]/.test(bare) && /^[0-9#?,.\s()\-;R@]*$/.test(bare);
}

/** An Excel date serial as YYYY-MM-DD (the 1900 or 1904 system), or null. */
export function serialDate(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}
