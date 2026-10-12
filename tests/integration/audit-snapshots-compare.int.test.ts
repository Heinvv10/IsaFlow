/**
 * Forensic-controls step 4 — comparison. After a snapshot is taken at 30 June:
 * a journal dated in May is posted (backdated), one is edited (amount and
 * description), one is reversed, one is removed, and a supplier is created.
 * "Compare to today" must name each, with the trial-balance movement and the
 * master-data change; a later snapshot compares the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asApp, members, newCompany } from './entity-changes.helpers';
import { cleanupAudit, plantJournal, plantLedger } from './audit-snapshots.helpers';
import { takeSnapshot } from '../../src/modules/accounting/services/audit/snapshotService';
import { ComparisonError, compareSnapshotToLive, compareSnapshots } from '../../src/modules/accounting/services/audit/comparisonService';
import type { AuditPrincipal } from '../../src/modules/accounting/services/audit/auditTx';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', m = '';

beforeAll(async () => {
  [o, m] = await members(pool, tokens, 2);
  await pool.query("UPDATE users SET first_name = 'Mia', last_name = 'Manager' WHERE id = $1", [m]);
  process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'c'.repeat(48);
  process.env.AUDIT_SNAPSHOT_KEY_ID = 'cmp-test';
});
afterAll(() => cleanupAudit(pool, companies, [o, m]));

const as = (user: string, c: string): AuditPrincipal => ({ userId: user, companyId: c, claims: { sub: user, session_id: crypto.randomUUID() } });

async function scenario() {
  const c = await newCompany(pool, [[o, 'owner'], [m, 'manager']], companies);
  const l = await plantLedger(pool, c);
  const sale = await plantJournal(pool, c, { date: '2026-03-10', amount: 1000, debit: l.bank, credit: l.sales, by: o });
  const rent = await plantJournal(pool, c, { date: '2026-04-06', amount: 500, debit: l.expense, credit: l.bank, by: o });
  const gone = await plantJournal(pool, c, { date: '2026-04-20', amount: 80, debit: l.expense, credit: l.bank, by: o });
  const july = await plantJournal(pool, c, { date: '2026-07-02', amount: 70, debit: l.expense, credit: l.bank, by: o });
  const base = await takeSnapshot(as(o, c), { cutoff: '2026-06-30', trigger: 'manual' });

  const backdated = await plantJournal(pool, c, { date: '2026-05-15', amount: 250, debit: l.expense, credit: l.bank, by: m,
    createdAt: new Date().toISOString() });
  await pool.query("UPDATE gl_journal_entries SET description = 'edited' WHERE id = $1", [sale]);
  await pool.query('UPDATE gl_journal_lines SET debit = CASE WHEN debit > 0 THEN 1100 ELSE 0 END, credit = CASE WHEN credit > 0 THEN 1100 ELSE 0 END WHERE journal_entry_id = $1', [sale]);
  const reversal = await plantJournal(pool, c, { date: '2026-06-01', amount: 500, debit: l.bank, credit: l.expense, by: o,
    reversalOf: rent, createdAt: new Date().toISOString() });
  await pool.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [rent, o]);
  await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [gone]);
  await pool.query('DELETE FROM gl_journal_entries WHERE id = $1', [gone]);
  const supplier = crypto.randomUUID();
  await asApp(pool, o, c, (db) => db.query('INSERT INTO suppliers(id, company_id, name) VALUES($1, $2, $3)', [supplier, c, 'New Co']));
  return { c, l, sale, rent, gone, july, base, backdated, reversal, supplier };
}

describe('compare to today', { timeout: 120_000 }, () => {
  it('names the backdated, changed, reversed and removed journals, the TB movement and the master-data change', async () => {
    const s = await scenario();
    const cmp = await compareSnapshotToLive(as(o, s.c), s.base.id);
    expect(cmp.backdated.map((j) => j.id).sort()).toEqual([s.backdated, s.reversal].sort());
    const bd = cmp.backdated.find((j) => j.id === s.backdated)!;
    expect(bd).toMatchObject({ entryDate: '2026-05-15', createdBy: m, postedBy: m });
    expect(cmp.names[m]).toBe('Mia Manager');
    expect(cmp.added).toEqual([]);
    const changed = Object.fromEntries(cmp.changed.map((j) => [j.id, j]));
    expect(changed[s.sale]!.fields).toEqual([{ field: 'description', before: 'planted', after: 'edited' }]);
    expect(changed[s.sale]!.lines.changed.flatMap((x) => x.fields.map((f) => `${f.field}:${f.before}>${f.after}`)).sort())
      .toEqual(['credit:1000.00>1100.00', 'debit:1000.00>1100.00']);
    expect(changed[s.rent]!.fields.map((f) => f.field).sort()).toEqual(['reversed_at', 'reversed_by']);
    expect(cmp.reversedAfter).toEqual([s.rent]);
    expect(cmp.removed).toEqual([expect.objectContaining({ id: s.gone, statusNow: 'deleted' })]);
    expect(JSON.stringify(cmp)).not.toContain(s.july);
    const tb = Object.fromEntries(cmp.tb.map((t) => [t.accountId, t]));
    // bank: +100 (sale) -250 (backdated) +500 (reversal) +80 (removed) = +430
    expect(tb[s.l.bank]).toMatchObject({ before: '420.00', after: '850.00', delta: '430.00' });
    expect(tb[s.l.sales]).toMatchObject({ before: '-1000.00', after: '-1100.00', delta: '-100.00' });
    expect(tb[s.l.expense]).toMatchObject({ before: '580.00', after: '250.00', delta: '-330.00' });
    expect(cmp.masterData).toMatchObject({ total: 1, byType: { supplier: 1 }, items: [{ entityId: s.supplier, op: 'create' }] });
    expect(cmp.counts).toMatchObject({ backdated: 2, added: 0, changed: 2, removed: 1, reversedAfter: 1, accountsMoved: 3 });
  });

  it('a later snapshot compares the same way; a later cutoff does not count its own new journals', async () => {
    const s = await scenario();
    const later = await takeSnapshot(as(o, s.c), { cutoff: '2026-07-31', trigger: 'manual' });
    const cmp = await compareSnapshots(as(o, s.c), s.base.id, later.id);
    expect(cmp.against).toMatchObject({ kind: 'snapshot', id: later.id });
    expect(cmp.backdated.map((j) => j.id).sort()).toEqual([s.backdated, s.reversal].sort());
    expect(cmp.changed.map((j) => j.id).sort()).toEqual([s.sale, s.rent].sort());
    expect(cmp.removed.map((j) => j.id)).toEqual([s.gone]);
    expect(JSON.stringify(cmp)).not.toContain(s.july);
    expect(cmp.tb.find((t) => t.accountId === s.l.bank)).toMatchObject({ delta: '430.00' });
    expect(cmp.masterData).toBeNull();
    await expect(compareSnapshots(as(o, s.c), later.id, s.base.id)).rejects.toBeInstanceOf(ComparisonError);
  });

  it('nothing changed reads as nothing; a manager compares too', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [m, 'manager']], companies);
    const l = await plantLedger(pool, c);
    await plantJournal(pool, c, { date: '2026-03-10', amount: 10, debit: l.bank, credit: l.sales, by: o });
    const base = await takeSnapshot(as(o, c), { cutoff: '2026-06-30', trigger: 'manual' });
    const cmp = await compareSnapshotToLive(as(m, c), base.id);
    expect(cmp.counts).toEqual({ backdated: 0, added: 0, changed: 0, removed: 0, reversedAfter: 0, linesChanged: 0, accountsMoved: 0 });
  });
});
