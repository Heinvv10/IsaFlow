/**
 * Pure rules for an intercompany connection: request shapes (400 before any cast reaches SQL), the
 * auto-accept rule (group only), the ordered company pair, and the per-side setup checklist.
 */
import { isRealCalendarDate, isUuidParam } from '@/lib/validation';
import type { Checklist, ChecklistItem, ConnectionKind, PairInput, PairSettings, SideInput, SideState } from './connectionTypes';

export type { SideState } from './connectionTypes';

export type Parsed<T> = ({ ok: true } & T) | { ok: false; error: string };

const SIDE_KEYS = ['customerId', 'supplierId', 'loanAccountId', 'defaultExpenseAccountId', 'autoAccept'] as const;
const UUID_KEYS = ['customerId', 'supplierId', 'loanAccountId', 'defaultExpenseAccountId'] as const;
const PAIR_KEYS = ['settlementMode', 'cutoverDate', 'interestRatePct'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseCreateInput(body: unknown): Parsed<{ partnerCompanyId: string }> {
  if (!isObject(body)) return { ok: false, error: 'A JSON object body is required' };
  const extra = Object.keys(body).filter((k) => k !== 'partnerCompanyId');
  if (extra.length > 0) return { ok: false, error: `Unknown field: ${extra[0]}` };
  if (!isUuidParam(body.partnerCompanyId)) return { ok: false, error: 'partnerCompanyId must be a valid UUID' };
  return { ok: true, partnerCompanyId: body.partnerCompanyId.toLowerCase() };
}

const unknownKey = (body: Record<string, unknown>, known: readonly string[]): string | undefined =>
  Object.keys(body).find((k) => !known.includes(k));

/** The settings of one side. Types only; ownership of the ids and the account rules are the service's. */
export function parseSideInput(body: unknown): Parsed<{ value: SideInput }> {
  if (!isObject(body)) return { ok: false, error: 'A JSON object body is required' };
  const extra = unknownKey(body, SIDE_KEYS);
  if (extra) return { ok: false, error: `Unknown field: ${extra}` };
  const value: SideInput = {};
  for (const k of UUID_KEYS) {
    const v = body[k];
    if (v === undefined) continue;
    if (v === null) { value[k] = null; continue; }
    if (!isUuidParam(v)) return { ok: false, error: `${k} must be a valid UUID or null` };
    value[k] = v.toLowerCase();
  }
  if (body.autoAccept !== undefined) {
    if (typeof body.autoAccept !== 'boolean') return { ok: false, error: 'autoAccept must be true or false' };
    value.autoAccept = body.autoAccept;
  }
  if (Object.keys(value).length === 0) return { ok: false, error: 'Nothing to update' };
  return { ok: true, value };
}

/** The pair's agreement: settlement mode, cut-over date, interest rate. Types and ranges only. */
export function parsePairInput(body: unknown): Parsed<{ value: PairInput }> {
  if (!isObject(body)) return { ok: false, error: 'A JSON object body is required' };
  const extra = unknownKey(body, PAIR_KEYS);
  if (extra) return { ok: false, error: `Unknown field: ${extra}` };
  const value: PairInput = {};
  if (body.settlementMode !== undefined) {
    if (body.settlementMode !== 'cash' && body.settlementMode !== 'loan') {
      return { ok: false, error: "settlementMode must be 'cash' or 'loan'" };
    }
    value.settlementMode = body.settlementMode;
  }
  if (body.cutoverDate !== undefined) {
    const d = body.cutoverDate;
    if (d !== null && (typeof d !== 'string' || !isRealCalendarDate(d))) {
      return { ok: false, error: 'cutoverDate must be a real date (YYYY-MM-DD) or null' };
    }
    value.cutoverDate = d;
  }
  if (body.interestRatePct !== undefined) {
    const r = body.interestRatePct;
    if (r !== null && (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 100)) {
      return { ok: false, error: 'interestRatePct must be a number from 0 to 100, or null' };
    }
    value.interestRatePct = r;
  }
  if (Object.keys(value).length === 0) return { ok: false, error: 'Nothing to update' };
  return { ok: true, value };
}

/** Ruling 8: auto-accept exists only on a group connection. Null when the change is allowed. */
export function autoAcceptRefusal(kind: ConnectionKind, autoAccept: boolean | undefined): string | null {
  if (autoAccept === true && kind !== 'group') return 'Auto-accept is only available on a group connection';
  return null;
}

/** The pair in the order the table stores it (low < high), compared as lowercase text as Postgres compares uuids. */
export function orderedPair(a: string, b: string): { low: string; high: string } {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? { low: x, high: y } : { low: y, high: x };
}

/** What is still to set up on one side: its own links, plus the pair's cut-over date (and the loan account in loan mode). */
export function computeChecklist(side: SideState | null, pair: Pick<PairSettings, 'settlementMode' | 'cutoverDate'>): Checklist {
  const items: ChecklistItem[] = [
    { key: 'customer', label: 'Customer linked (who the partner is when you invoice them)', required: true, done: Boolean(side?.customerId) },
    { key: 'supplier', label: 'Supplier linked (who the partner is when they invoice you)', required: true, done: Boolean(side?.supplierId) },
    { key: 'loanAccount', label: 'Loan account set (needed when settling through a loan)', required: pair.settlementMode === 'loan', done: Boolean(side?.loanAccountId) },
    { key: 'cutover', label: 'Cut-over date set', required: true, done: Boolean(pair.cutoverDate) },
  ];
  return { items, complete: items.every((i) => !i.required || i.done) };
}
