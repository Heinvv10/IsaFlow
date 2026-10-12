/**
 * Forensic-controls step 4 — taking and verifying a snapshot through the
 * service (the real SQL, the real writer, the real seal):
 *  - what is frozen: posted journals and lines dated on or before the cutoff,
 *    the trial balance they make, totals, and a sealed check run;
 *  - Verify recomputes everything from the stored rows: an altered row, an
 *    altered hash column or a forged snapshot is invalid; another key is unknown;
 *  - the size cap and a missing key refuse before anything is written;
 *  - seeded leads (a backdated journal, a threshold split) are findings.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { members, newCompany } from './entity-changes.helpers';
import { cleanupAudit, payload, plantJournal, plantLedger, recordSnapshot, type Ledger } from './audit-snapshots.helpers';
import { SnapshotTooLargeError, takeSnapshot } from '../../src/modules/accounting/services/audit/snapshotService';
import { verifySnapshot } from '../../src/modules/accounting/services/audit/snapshotVerify';
import { SigningKeyMissingError } from '../../src/modules/accounting/services/audit/seal';
import { getCheckRun, snapshotTb } from '../../src/modules/accounting/services/audit/snapshotRead';
import { runAuditTx, type AuditPrincipal } from '../../src/modules/accounting/services/audit/auditTx';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '';
const KEY = { key: Buffer.from('s'.repeat(48)), keyId: 'svc-test' };

beforeAll(async () => {
  [o] = await members(pool, tokens, 1);
  process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 's'.repeat(48);
  process.env.AUDIT_SNAPSHOT_KEY_ID = 'svc-test';
});
afterEach(() => { process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 's'.repeat(48); });
afterAll(() => cleanupAudit(pool, companies, [o]));

const principal = (c: string): AuditPrincipal => ({ userId: o, companyId: c, claims: { sub: o, session_id: crypto.randomUUID() } });
/** Reads as the owner would, in an audit transaction (RLS on). */
const read = <T>(c: string, fn: () => Promise<T>) => runAuditTx(principal(c), 'READ COMMITTED', fn);

async function books(): Promise<{ c: string; l: Ledger; j: string[] }> {
  const c = await newCompany(pool, [[o, 'owner']], companies);
  const l = await plantLedger(pool, c);
  const j = [
    await plantJournal(pool, c, { date: '2026-03-10', amount: 1000, debit: l.bank, credit: l.sales, by: o }),
    await plantJournal(pool, c, { date: '2026-04-05', amount: 500, debit: l.expense, credit: l.bank, by: o }),
    await plantJournal(pool, c, { date: '2026-07-02', amount: 70, debit: l.expense, credit: l.bank, by: o }),
    await plantJournal(pool, c, { date: '2026-05-01', amount: 30, debit: l.expense, credit: l.bank, by: o, status: 'draft' }),
  ];
  return { c, l, j };
}

const count = async (t: string, c: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE company_id = $1`, [c])).rows[0].n as number;

describe('taking', () => {
  it('freezes the posted journals and lines on or before the cutoff and the trial balance they make, sealed', async () => {
    const { c, l, j } = await books();
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    expect([s.journals, s.lines, s.accounts]).toEqual([2, 4, 3]);
    const { rows: stored } = await pool.query('SELECT journal_id::text AS id FROM audit_snapshot_journals WHERE snapshot_id = $1 ORDER BY 1', [s.id]);
    expect(stored.map((r) => r.id)).toEqual([j[0], j[1]].sort());
    const tb = await read(c, () => snapshotTb(c, s.id));
    const closing = Object.fromEntries(tb.map((t) => [t.accountId, t.row.closing]));
    expect(closing).toEqual({ [l.bank]: '500.00', [l.sales]: '-1000.00', [l.expense]: '500.00' });
    const { rows: [h] } = await pool.query('SELECT status, trigger, taken_by, channel, totals FROM audit_snapshots WHERE id = $1', [s.id]);
    expect(h).toMatchObject({ status: 'sealed', trigger: 'manual', taken_by: o, channel: 'session' });
    expect(h.totals).toMatchObject({ journal_count: 2, line_count: 4, total_debit: '1500.00', total_credit: '1500.00' });
    const run = await read(c, () => getCheckRun(c, s.checkRunId));
    expect(run!.results.map((r) => r.family).sort()).toEqual([
      ...Array(4).fill('anomaly'), ...Array(15).fill('integrity'), ...Array(5).fill('journal_risk')]);
    expect((await read(c, () => verifySnapshot(c, s.id, KEY)))!.status).toBe('valid');
  });

  it('refuses over the size cap and without a key, writing nothing', async () => {
    const { c } = await books();
    await expect(takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual', maxLines: 3 }))
      .rejects.toBeInstanceOf(SnapshotTooLargeError);
    process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'short';
    await expect(takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' })).rejects.toBeInstanceOf(SigningKeyMissingError);
    expect(await count('audit_snapshots', c)).toBe(0);
    expect(await count('audit_check_runs', c)).toBe(0);
  });
});

describe('verifying', () => {
  async function alter(table: string, sqlText: string, args: unknown[]) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_append_only`);
      await db.query(sqlText, args);
      await db.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${table}_append_only`);
      await db.query('COMMIT');
    } finally { db.release(); }
  }

  it('an altered line is invalid, and so is one whose stored hash was altered to match', async () => {
    const { c } = await books();
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    const { rows: [line] } = await pool.query("SELECT line_id FROM audit_snapshot_lines WHERE snapshot_id = $1 AND row->>'debit' <> '0.00' LIMIT 1", [s.id]);
    await alter('audit_snapshot_lines', `UPDATE audit_snapshot_lines SET row = jsonb_set(row, '{debit}', '"999.00"') WHERE snapshot_id = $1 AND line_id = $2`, [s.id, line.line_id]);
    const v = (await read(c, () => verifySnapshot(c, s.id, KEY)))!;
    expect(v).toMatchObject({ status: 'invalid', rowMismatchCount: 1, rowMismatches: [{ kind: 'line', id: line.line_id }] });
    const { rows: [row] } = await pool.query('SELECT row FROM audit_snapshot_lines WHERE snapshot_id = $1 AND line_id = $2', [s.id, line.line_id]);
    const { materialHash } = await import('../../src/modules/accounting/services/audit/canonical');
    await alter('audit_snapshot_lines', 'UPDATE audit_snapshot_lines SET material_hash = $3 WHERE snapshot_id = $1 AND line_id = $2',
      [s.id, line.line_id, materialHash(row.row)]);
    const v2 = (await read(c, () => verifySnapshot(c, s.id, KEY)))!;
    expect(v2.rowMismatchCount).toBe(0);
    expect(v2.status).toBe('invalid');
    expect(v2.recomputedHash).not.toBe(v2.canonicalHash);
  });

  it('an altered check result or trial balance row is invalid', async () => {
    const { c } = await books();
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    await alter('audit_check_results', "UPDATE audit_check_results SET finding_count = finding_count + 7 WHERE run_id = $1 AND check_id = 'journal_risk.backdated_entry'", [s.checkRunId]);
    const v = (await read(c, () => verifySnapshot(c, s.id, KEY)))!;
    expect(v.status).toBe('invalid');
    expect(v.checkRun).toMatchObject({ hashMatches: false });
    const s2 = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    await alter('audit_snapshot_tb', `UPDATE audit_snapshot_tb SET row = jsonb_set(row, '{closing}', '"1.00"') WHERE snapshot_id = $1`, [s2.id]);
    expect((await read(c, () => verifySnapshot(c, s2.id, KEY)))!.status).toBe('invalid');
  });

  it('a snapshot recorded through the writer without the key never verifies; another key id is unknown', async () => {
    const { c } = await books();
    const forged = await recordSnapshot(pool, o, c, (t) => payload(c, o, t, { key_id: KEY.keyId }));
    expect((await read(c, () => verifySnapshot(c, forged, KEY)))!.status).toBe('invalid');
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    expect((await read(c, () => verifySnapshot(c, s.id, { ...KEY, keyId: 'other' })))!.status).toBe('unknown_key');
    expect((await read(c, () => verifySnapshot(c, s.id, { key: Buffer.from('t'.repeat(48)), keyId: KEY.keyId })))!.status).toBe('invalid');
  });
});

describe('checks inside a snapshot', () => {
  it('a backdated journal and a threshold split are findings', async () => {
    const { c, l } = await books();
    const late = await plantJournal(pool, c, { date: '2026-03-01', amount: 40, debit: l.expense, credit: l.bank, by: o,
      createdAt: '2026-06-20T09:00:00+02:00' });
    await pool.query(
      `INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
       VALUES($1,'mj','manual_journal','amount','greater_than',1000,'admin',true)`, [c]);
    const a = await plantJournal(pool, c, { date: '2026-05-12', amount: 600, debit: l.expense, credit: l.bank, by: o, createdAt: '2026-05-12T09:00:00+02:00' });
    const b = await plantJournal(pool, c, { date: '2026-05-12', amount: 600, debit: l.expense, credit: l.bank, by: o, createdAt: '2026-05-12T09:30:00+02:00' });
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    const run = (await read(c, () => getCheckRun(c, s.checkRunId)))!;
    const byId = Object.fromEntries(run.results.map((r) => [r.checkId, r]));
    expect(byId['journal_risk.backdated_entry']).toMatchObject({ status: 'fail', findingCount: 1, findings: [{ refs: [late] }] });
    expect(byId['journal_risk.threshold_split']).toMatchObject({ status: 'fail', findingCount: 1 });
    expect(byId['journal_risk.threshold_split']!.findings[0]!.refs).toEqual([a, b].sort());
    // 5 April 2026 is a Sunday (a planted journal); the 09:00 Tuesday pair is in hours.
    const offHours = byId['journal_risk.outside_business_hours']!.findings.flatMap((f) => f.refs);
    expect(offHours).not.toContain(a);
    expect(offHours).not.toContain(b);
    expect(offHours).toContain(late);
  });
});
