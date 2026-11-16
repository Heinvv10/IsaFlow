/**
 * The payroll oracle's emp201 kind (wave-6 O3): ETI carried forward and refunded across an EMP201 range, costed by the
 * pure etiCarryLedger / summariseCarry (etiCarry.ts) and compared to the cent with figures worked from a SARS source.
 * Same source rules as the line cases (validate.ts SOURCE_PATTERN, personal-data masking).
 * NAMED LIMIT: this kind has no gap list yet, so every case must match; an UNVERIFIED case is refused until one exists.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { etiCarryLedger, summariseCarry, type EtiCarry, type EtiMonth, type YearMonth } from '@/modules/accounting/services/payroll/etiCarry';
import { assertNoPersonalData } from './validate';

export const EMP201_DIR = join(__dirname, 'emp201');
export const EMP201_FIELDS = ['broughtForward', 'used', 'carriedForward', 'refundClaimable'] as const;
type Emp201Field = typeof EMP201_FIELDS[number];

export interface Emp201Case {
  id: string;
  source: string;
  sourceRef: string;
  notes: string;
  input: { from: YearMonth; to: YearMonth; months: EtiMonth[] };
  expected: Record<Emp201Field, number>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const exactKeys = (o: Obj, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every(k => k in o);
const isYm = (v: unknown) => isObj(v) && exactKeys(v, ['year', 'month']) && Number.isInteger(v.year)
  && Number.isInteger(v.month) && (v.month as number) >= 1 && (v.month as number) <= 12;
const ymIndex = (v: YearMonth) => v.year * 12 + v.month - 1;

/** Shape and source checks; throws a named error. Every key is accounted for: anything else is refused. */
export function validateEmp201Case(raw: unknown, file: string): void {
  assertNoPersonalData(raw, file);
  const need = (cond: boolean, what: string) => { if (!cond) throw new Error(`${file}: ${what}`); };
  need(isObj(raw) && exactKeys(raw, ['id', 'source', 'sourceRef', 'notes', 'input', 'expected']), 'needs exactly id, source, sourceRef, notes, input, expected');
  const c = raw as Obj;
  need(`${String(c.id)}.json` === file, `id "${String(c.id)}" must match the file name`);
  need(typeof c.source === 'string' && /^(sage|simplepay|both|sars-guide:.+)$/.test(c.source), `source "${String(c.source)}" is not sage | simplepay | both | sars-guide:<ref>`);
  need(typeof c.sourceRef === 'string' && c.sourceRef.length > 0 && typeof c.notes === 'string' && c.notes.length > 0, 'sourceRef and notes are required');
  need(isObj(c.input) && exactKeys(c.input, ['from', 'to', 'months']), 'input needs exactly from, to, months');
  const input = c.input as Obj;
  need(isYm(input.from) && isYm(input.to) && ymIndex(input.from as YearMonth) <= ymIndex(input.to as YearMonth), 'input.from and input.to are year/month, in order');
  need(Array.isArray(input.months) && input.months.length > 0, 'input.months must be a non-empty array');
  (input.months as unknown[]).forEach((m, i) => need(isObj(m) && exactKeys(m, ['year', 'month', 'paye', 'eti']) && isYm({ year: m.year, month: m.month })
    && isNum(m.paye) && isNum(m.eti), `input.months[${i}] needs exactly year, month, paye, eti`));
  need(isObj(c.expected) && exactKeys(c.expected, EMP201_FIELDS) && EMP201_FIELDS.every(f => isNum((c.expected as Obj)[f])),
    `expected needs exactly ${EMP201_FIELDS.join(', ')}, each a number`);
}

export function loadEmp201Cases(): Emp201Case[] {
  return readdirSync(EMP201_DIR).filter(f => f.endsWith('.json')).sort().map(f => {
    const raw: unknown = JSON.parse(readFileSync(join(EMP201_DIR, f), 'utf8'));
    validateEmp201Case(raw, f);
    return raw as Emp201Case;
  });
}

/** The range's carry as the EMP201 reads it: the ledger from the start of `from`'s reconciliation period to `to`. */
export function runEmp201Case(c: Emp201Case): EtiCarry {
  return summariseCarry(etiCarryLedger(c.input.from, c.input.to, c.input.months), c.input.from);
}

/** Every field that misses its expected figure, as messages (empty = matches to the cent). */
export function emp201CaseProblems(c: Emp201Case): string[] {
  const actual = runEmp201Case(c);
  return EMP201_FIELDS.filter(f => Math.round(actual[f] * 100) !== Math.round(c.expected[f] * 100))
    .map(f => `${c.id}.${f}: ledger ${actual[f]}, ${c.source} ${c.expected[f]}`);
}
