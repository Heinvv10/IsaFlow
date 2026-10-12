/**
 * Comparing two sets of canonical rows (a snapshot's against today's books,
 * or against another snapshot) — pure set logic over ids and material hashes,
 * with field-level before / after for every changed row. No I/O.
 *
 * Backdating: a journal present on the "after" side, dated on or before the
 * cutoff, created or posted after the base was taken — it entered a period
 * the base had already frozen. Timestamps are the database's own UTC spelling
 * (fixed width), so string order is time order.
 */
import type { CanonicalRow } from './snapshotRows';

export interface Keyed { id: string; row: CanonicalRow; materialHash: string }
export interface FieldDiff { field: string; before: string | null; after: string | null }
export interface RowChange { id: string; fields: FieldDiff[] }
export interface SetDiff { added: Keyed[]; removed: Keyed[]; changed: { before: Keyed; after: Keyed; fields: FieldDiff[] }[] }

export function fieldDiff(before: CanonicalRow, after: CanonicalRow): FieldDiff[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => (before[k] ?? null) !== (after[k] ?? null))
    .map((k) => ({ field: k, before: before[k] ?? null, after: after[k] ?? null }));
}

export function diffSets(base: Keyed[], other: Keyed[]): SetDiff {
  const b = new Map(base.map((r) => [r.id, r]));
  const o = new Map(other.map((r) => [r.id, r]));
  const out: SetDiff = { added: [], removed: [], changed: [] };
  for (const r of other) {
    const was = b.get(r.id);
    if (!was) out.added.push(r);
    else if (was.materialHash !== r.materialHash) out.changed.push({ before: was, after: r, fields: fieldDiff(was.row, r.row) });
  }
  for (const r of base) if (!o.has(r.id)) out.removed.push(r);
  const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  out.added.sort(byId);
  out.removed.sort(byId);
  out.changed.sort((x, y) => byId(x.after, y.after));
  return out;
}

/** Recorded after the base was taken: created or posted after `takenAt`. */
export function recordedAfter(row: CanonicalRow, takenAt: string): boolean {
  return (row.created_at ?? '') > takenAt || (row.posted_at ?? '') > takenAt;
}

export interface TbDelta { accountId: string; code: string | null; name: string | null; before: string; after: string; delta: string }

const cents = (v: string | null | undefined): bigint => {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(v ?? '0');
  if (!m) return 0n;
  const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -c : c;
};
const fmt = (c: bigint): string => {
  const abs = c < 0n ? -c : c;
  return `${c < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

/** Closing balance per account, before and after; only accounts that moved. */
export function tbDeltas(before: { accountId: string; row: CanonicalRow }[], after: { accountId: string; row: CanonicalRow }[]): TbDelta[] {
  const b = new Map(before.map((t) => [t.accountId, t.row]));
  const a = new Map(after.map((t) => [t.accountId, t.row]));
  const ids = [...new Set([...b.keys(), ...a.keys()])].sort();
  const out: TbDelta[] = [];
  for (const id of ids) {
    const x = cents(b.get(id)?.closing);
    const y = cents(a.get(id)?.closing);
    if (x === y) continue;
    const row = a.get(id) ?? b.get(id)!;
    out.push({ accountId: id, code: row.account_code ?? null, name: row.account_name ?? null, before: fmt(x), after: fmt(y), delta: fmt(y - x) });
  }
  return out;
}
