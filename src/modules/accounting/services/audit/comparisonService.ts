/**
 * What changed in the books for a snapshot's cutoff — against today's books
 * (compareSnapshotToLive) or against a later snapshot (compareSnapshots):
 *  - journals dated on or before the cutoff that are NEW, split into
 *    backdated (recorded after the base was taken) and the rest;
 *  - journals CHANGED (material hash differs) with field-level before /
 *    after, their line changes, and which were reversed after the base;
 *  - journals REMOVED (no longer posted, or gone) with their status now;
 *  - the closing balance of every account that moved;
 *  - against today: master-data changes recorded since the snapshot was
 *    taken (the change history, read under the reader's own RLS).
 * Today's books are read in one REPEATABLE READ transaction as the reader.
 */
import { sql } from '@/lib/neon';
import { listEntityChanges } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { ENTITY_TYPES, mayReadType } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { runAuditTx, transactionNow, type AuditPrincipal } from './auditTx';
import { getSnapshot, snapshotRows, snapshotTb, type SnapshotRecord, type StoredRow } from './snapshotRead';
import { journalRows, lineRows, tbRows } from './snapshotRows';
import { sumMoney } from './documents';
import { verifySnapshot } from './snapshotVerify';
import { diffSets, recordedAfter, tbDeltas, type FieldDiff, type Keyed, type TbDelta } from './comparisonDiff';

/** Rows listed per category; counts are never capped. */
export const MAX_LISTED = 500;
const MAX_CHANGE_PAGES = 10;

export interface JournalItem {
  id: string; entryNumber: string | null; entryDate: string | null; createdBy: string | null; createdAt: string | null;
  postedBy: string | null; postedAt: string | null; reversedAt: string | null; fields: FieldDiff[];
  lines: { added: number; removed: number; changed: { id: string; fields: FieldDiff[] }[] };
  /**
   * For a journal that entered the frozen period after the snapshot: created or posted after it was taken (true), or
   * recorded before it — re-dated into the period, committed late, or flipped to posted without a posting time (false).
   */
  recordedAfter?: boolean;
}

export interface Comparison {
  base: { id: string; cutoff: string; takenAt: string };
  against: { kind: 'live' | 'snapshot'; id: string | null; takenAt: string };
  /** Whether each side verified before it was compared (a side that does not verify is refused). */
  verification: { base: string; against: string | null };
  /**
   * backdated: every journal dated on or before the cutoff that was not in the snapshot — it entered the frozen period
   * after the freeze, whatever its timestamps say (recordedBefore of them carry timestamps from before the snapshot).
   */
  counts: { backdated: number; recordedBefore: number; changed: number; removed: number; reversedAfter: number; linesChanged: number; accountsMoved: number };
  backdated: JournalItem[]; changed: JournalItem[];
  removed: (JournalItem & { statusNow: string | null })[]; reversedAfter: string[];
  tb: TbDelta[];
  /** Columns only one side froze (the base predates freezing them), per row kind: not compared. */
  notCompared: { journals: string[]; lines: string[] };
  /** Display names of the people who created or posted a listed journal (current members only). */
  names: Record<string, string>;
  masterData: { since: string; total: number; truncated: boolean; byType: Record<string, number>;
    items: { type: string; entityId: string; label: string | null; op: string; recordedAt: string; actor: string; actorName: string | null }[] } | null;
}

export class ComparisonError extends Error {
  constructor(message: string) { super(message); this.name = 'ComparisonError'; }
}

const keyed = (rows: StoredRow[] | { id: string; row: Keyed['row']; materialHash: string }[]): Keyed[] =>
  rows.map((r) => ({ id: r.id, row: r.row, materialHash: r.materialHash }));

function item(r: Keyed, fields: FieldDiff[], lines: JournalItem['lines']): JournalItem {
  const v = r.row;
  return { id: r.id, entryNumber: v.entry_number ?? null, entryDate: v.entry_date ?? null, createdBy: v.created_by ?? null,
    createdAt: v.created_at ?? null, postedBy: v.posted_by ?? null, postedAt: v.posted_at ?? null, reversedAt: v.reversed_at ?? null,
    fields, lines };
}

interface Side {
  journals: Keyed[];
  lines: (Keyed & { journalId: string; account?: StoredRow['account'] })[];
  tb: { accountId: string; row: Keyed['row'] }[];
}

function compare(base: SnapshotRecord, before: Side, after: Side, against: Comparison['against']): Comparison {
  const j = diffSets(before.journals, after.journals);
  const l = diffSets(before.lines, after.lines);
  const journalOf = new Map([...before.lines, ...after.lines].map((x) => [x.id, x.journalId]));
  const lineChanges = new Map<string, JournalItem['lines']>();
  const bucket = (jid: string) => lineChanges.get(jid) ?? (lineChanges.set(jid, { added: 0, removed: 0, changed: [] }), lineChanges.get(jid)!);
  for (const x of l.added) bucket(journalOf.get(x.id)!).added += 1;
  for (const x of l.removed) bucket(journalOf.get(x.id)!).removed += 1;
  for (const x of l.changed) bucket(journalOf.get(x.after.id)!).changed.push({ id: x.after.id, fields: x.fields });
  const none = { added: 0, removed: 0, changed: [] };

  const backdated = j.added.map((r) => ({ ...item(r, [], lineChanges.get(r.id) ?? none), recordedAfter: recordedAfter(r.row, base.takenAt) }));
  const changedIds = new Set(j.changed.map((c) => c.after.id));
  const afterById = new Map(after.journals.map((x) => [x.id, x]));
  const beforeIds = new Set(before.journals.map((x) => x.id));
  // A journal whose header is unchanged but whose lines moved is a changed journal too.
  const lineOnly = [...lineChanges.keys()].filter((id) => !changedIds.has(id) && afterById.has(id) && beforeIds.has(id));
  const changed = [
    ...j.changed.map((c) => item(c.after, c.fields, lineChanges.get(c.after.id) ?? none)),
    ...lineOnly.map((id) => item(afterById.get(id)!, [], lineChanges.get(id)!)),
  ];
  const reversedAfter = j.changed.filter((c) => (c.after.row.reversed_at ?? '') > base.takenAt).map((c) => c.after.id);
  const tb = tbDeltas(before.tb, after.tb);
  return {
    base: { id: base.id, cutoff: base.cutoff, takenAt: base.takenAt }, against,
    verification: { base: 'valid', against: null },
    counts: { backdated: backdated.length, recordedBefore: backdated.filter((x) => !x.recordedAfter).length, changed: changed.length, removed: j.removed.length,
      reversedAfter: reversedAfter.length, linesChanged: l.added.length + l.removed.length + l.changed.length, accountsMoved: tb.length },
    backdated: backdated.slice(0, MAX_LISTED),
    changed: changed.slice(0, MAX_LISTED),
    removed: j.removed.slice(0, MAX_LISTED).map((r) => ({ ...item(r, [], lineChanges.get(r.id) ?? none), statusNow: null })),
    reversedAfter: reversedAfter.slice(0, MAX_LISTED), tb, notCompared: { journals: j.notCompared, lines: l.notCompared },
    names: {}, masterData: null,
  };
}

/** Names for every person a listed journal was created or posted by. */
async function withNames(companyId: string, c: Comparison): Promise<Comparison> {
  const ids = [...new Set([...c.backdated, ...c.changed, ...c.removed]
    .flatMap((j) => [j.createdBy, j.postedBy]).filter((x): x is string => !!x))];
  if (ids.length === 0) return c;
  const rows = (await sql`
    SELECT u.id AS id, public.approval_company_member_name(${companyId}::UUID, u.id) AS name
    FROM unnest(${ids}::TEXT[]) AS u(id)
  `) as { id: string; name: string | null }[];
  return { ...c, names: Object.fromEntries(rows.filter((r) => r.name).map((r) => [r.id, r.name!])) };
}

/** A snapshot's stored rows, restricted to journals dated on or before `cutoff` when given. */
async function storedSide(companyId: string, s: SnapshotRecord, cutoff?: string): Promise<Side> {
  const journals = keyed(await snapshotRows(companyId, s.id, 'journals'))
    .filter((j) => !cutoff || (j.row.entry_date ?? '') <= cutoff);
  const kept = new Set(journals.map((j) => j.id));
  const lines = (await snapshotRows(companyId, s.id, 'lines')).filter((r) => kept.has(r.journalId))
    .map((r) => ({ id: r.id, row: r.row, materialHash: r.materialHash, journalId: r.journalId, account: r.account }));
  return { journals, lines, tb: cutoff ? closingFromLines(lines) : await snapshotTb(companyId, s.id) };
}

/** Closing balance per account (all posted lines to the cutoff, debit positive) — what a TB row's closing is. */
function closingFromLines(lines: Side['lines']): Side['tb'] {
  const by = new Map<string, { row: Keyed['row']; values: string[]; neg: string[] }>();
  for (const l of lines) {
    const id = l.row.account_id ?? '';
    const e = by.get(id) ?? { row: { account_code: l.account?.code ?? null, account_name: l.account?.name ?? null }, values: [], neg: [] };
    e.values.push(l.row.debit ?? '0.00');
    e.neg.push(l.row.credit ?? '0.00');
    by.set(id, e);
  }
  return [...by.entries()].map(([accountId, e]) => {
    const net = sumMoney([...e.values, ...e.neg.map((c) => (c.startsWith('-') ? c.slice(1) : `-${c}`))]);
    return { accountId, row: { ...e.row, closing: net } };
  });
}

/** A sealed snapshot that verifies: nothing is compared against an altered or unverifiable one. */
async function sealedSnapshot(companyId: string, id: string): Promise<{ s: SnapshotRecord; verified: string }> {
  const s = await getSnapshot(companyId, id);
  if (!s) throw new ComparisonError('Snapshot not found.');
  if (s.status !== 'sealed') throw new ComparisonError('This snapshot attempt holds no books of its own to compare.');
  const v = await verifySnapshot(companyId, id);
  if (v?.status !== 'valid') {
    throw new ComparisonError(`Snapshot ${id} does not verify (${v?.status ?? 'unknown'}): its stored rows or seal do not match, so it is not compared.`);
  }
  return { s, verified: v.status };
}

async function masterDataSince(companyId: string, role: string | undefined, since: string): Promise<NonNullable<Comparison['masterData']>> {
  const types = ENTITY_TYPES.filter((t) => mayReadType(role, t));
  const items: NonNullable<Comparison['masterData']>['items'] = [];
  let before: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
    const p = await listEntityChanges(companyId, { types, since, before, limit: 100 });
    items.push(...p.items.map((c) => ({ type: c.entityType, entityId: c.entityId, label: c.entityLabel, op: c.op,
      recordedAt: c.recordedAt, actor: c.actor, actorName: c.actorName })));
    if (!p.nextCursor) break;
    before = p.nextCursor;
    if (page === MAX_CHANGE_PAGES - 1) truncated = true;
  }
  const byType: Record<string, number> = {};
  for (const i of items) byType[i.type] = (byType[i.type] ?? 0) + 1;
  return { since, total: items.length, truncated, byType, items: items.slice(0, 100) };
}

export async function compareSnapshotToLive(p: AuditPrincipal, snapshotId: string): Promise<Comparison> {
  return runAuditTx(p, 'REPEATABLE READ', async (client) => {
    const { s: base, verified } = await sealedSnapshot(p.companyId, snapshotId);
    const fyStart = String(base.totals.fy_start ?? base.cutoff);
    const live: Side = {
      journals: keyed((await journalRows(p.companyId, base.cutoff)).map((r) => ({ id: r.journalId, row: r.row, materialHash: r.materialHash }))),
      lines: (await lineRows(p.companyId, base.cutoff)).map((r) => ({ id: r.lineId, row: r.row, materialHash: r.materialHash, journalId: r.journalId })),
      tb: await tbRows(p.companyId, base.cutoff, fyStart),
    };
    const out = await withNames(p.companyId,
      compare(base, await storedSide(p.companyId, base), live, { kind: 'live', id: null, takenAt: await transactionNow(client) }));
    out.verification = { base: verified, against: null };
    if (out.removed.length > 0) {
      const now = (await sql`
        SELECT id::TEXT AS id, status, entry_date::TEXT AS d FROM gl_journal_entries
        WHERE company_id = ${p.companyId}::UUID AND id = ANY(${out.removed.map((r) => r.id)}::UUID[])
      `) as { id: string; status: string; d: string }[];
      const by = new Map(now.map((r) => [r.id, r.d > base.cutoff ? `${r.status} (redated ${r.d})` : r.status]));
      for (const r of out.removed) r.statusNow = by.get(r.id) ?? 'deleted';
    }
    const { rows: [role] } = await client.query<{ r: string | null }>('SELECT public.company_member_actor_role($1::uuid) AS r', [p.companyId]);
    out.masterData = await masterDataSince(p.companyId, role?.r ?? undefined, base.takenAt);
    return out;
  });
}

/**
 * `a` is the earlier base; `b` a later snapshot of the same company at the same or a later cutoff. Both are read
 * at a's cutoff: b's journals dated after it are out of scope, and closings come from the lines on both sides.
 */
export async function compareSnapshots(p: AuditPrincipal, a: string, b: string): Promise<Comparison> {
  return runAuditTx(p, 'REPEATABLE READ', async () => {
    const { s: base, verified } = await sealedSnapshot(p.companyId, a);
    const { s: other, verified: otherVerified } = await sealedSnapshot(p.companyId, b);
    if (other.cutoff < base.cutoff) throw new ComparisonError('Compare against a snapshot at the same or a later cutoff.');
    if (other.takenAt <= base.takenAt) throw new ComparisonError('Compare an earlier snapshot against a later one.');
    const out = await withNames(p.companyId, compare(base, await storedSide(p.companyId, base, base.cutoff),
      await storedSide(p.companyId, other, base.cutoff), { kind: 'snapshot', id: other.id, takenAt: other.takenAt }));
    out.verification = { base: verified, against: otherVerified };
    if (out.removed.length > 0) {
      // What the later snapshot holds for each, read from its own rows (it may have been re-dated past the cutoff).
      const later = new Map((await snapshotRows(p.companyId, other.id, 'journals')).map((j) => [j.id, j.row]));
      for (const r of out.removed) {
        const row = later.get(r.id);
        r.statusNow = !row ? 'not in the later snapshot (deleted or no longer posted)'
          : (row.entry_date ?? '') > base.cutoff ? `${row.status ?? '?'} (redated ${row.entry_date})` : (row.status ?? null);
      }
    }
    return out;
  });
}
