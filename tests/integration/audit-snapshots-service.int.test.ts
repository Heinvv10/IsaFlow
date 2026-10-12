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
import { verifyChain, verifySnapshot } from '../../src/modules/accounting/services/audit/snapshotVerify';
import { SNAPSHOT_SEAL_DOMAIN, SigningKeyMissingError, sign } from '../../src/modules/accounting/services/audit/seal';
import { getCheckRun, snapshotTb } from '../../src/modules/accounting/services/audit/snapshotRead';
import { SnapshotBusyError, runAuditTx, type AuditPrincipal } from '../../src/modules/accounting/services/audit/auditTx';

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

describe('taking', { timeout: 120_000 }, () => {
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

describe('verifying', { timeout: 120_000 }, () => {
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

  it('an altered stored hash alone (the row untouched) is invalid too', async () => {
    const { c } = await books();
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    const { rows: [j] } = await pool.query('SELECT journal_id FROM audit_snapshot_journals WHERE snapshot_id = $1 LIMIT 1', [s.id]);
    await alter('audit_snapshot_journals', 'UPDATE audit_snapshot_journals SET material_hash = $3 WHERE snapshot_id = $1 AND journal_id = $2',
      [s.id, j.journal_id, 'f'.repeat(64)]);
    expect((await read(c, () => verifySnapshot(c, s.id, KEY)))!).toMatchObject({ status: 'invalid', rowMismatchCount: 1 });
  });

  it('after a key rotation, old seals verify under the retired key and tampering is still invalid', async () => {
    const { c } = await books();
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    const { rows: [line] } = await pool.query("SELECT line_id FROM audit_snapshot_lines WHERE snapshot_id = $1 AND row->>'debit' <> '0.00' LIMIT 1", [s.id]);
    await alter('audit_snapshot_lines', `UPDATE audit_snapshot_lines SET row = jsonb_set(row, '{debit}', '"1.00"') WHERE snapshot_id = $1 AND line_id = $2`, [s.id, line.line_id]);
    const rotated = { key: Buffer.from('n'.repeat(48)), keyId: 'rotated', retired: new Map([[KEY.keyId, { key: KEY.key, retiredAt: Date.now() + 3_600_000 }]]) };
    expect((await read(c, () => verifySnapshot(c, s.id, rotated)))!.status).toBe('invalid');
    // Untouched: verifies under the retired key after rotation; without that key held, it cannot be vouched for.
    const t = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    expect((await read(c, () => verifySnapshot(c, t.id, rotated)))!.status).toBe('valid');
    expect((await read(c, () => verifySnapshot(c, t.id, { ...rotated, retired: new Map() })))!.status).toBe('invalid');
  });

  it('a row moved by its filing column (a line to another journal, a journal to another date, a TB row to another account) is invalid', async () => {
    const { c, j } = await books();
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    const { rows: [line] } = await pool.query('SELECT line_id, journal_id FROM audit_snapshot_lines WHERE snapshot_id = $1 AND journal_id = $2 LIMIT 1', [s.id, j[0]]);
    await alter('audit_snapshot_lines', 'UPDATE audit_snapshot_lines SET journal_id = $3 WHERE snapshot_id = $1 AND line_id = $2', [s.id, line.line_id, j[1]]);
    expect((await read(c, () => verifySnapshot(c, s.id, KEY)))!).toMatchObject({ status: 'invalid', rowMismatches: [{ kind: 'line', id: line.line_id }] });
    const s2 = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    await alter('audit_snapshot_journals', "UPDATE audit_snapshot_journals SET entry_date = '2026-01-01' WHERE snapshot_id = $1 AND journal_id = $2", [s2.id, j[0]]);
    expect((await read(c, () => verifySnapshot(c, s2.id, KEY)))!).toMatchObject({ status: 'invalid', rowMismatches: [{ kind: 'journal', id: j[0] }] });
    const s3 = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    const other = crypto.randomUUID();
    const { rows: [tbRow] } = await pool.query('SELECT account_id FROM audit_snapshot_tb WHERE snapshot_id = $1 LIMIT 1', [s3.id]);
    await alter('audit_snapshot_tb', 'UPDATE audit_snapshot_tb SET account_id = $3 WHERE snapshot_id = $1 AND account_id = $2', [s3.id, tbRow.account_id, other]);
    expect((await read(c, () => verifySnapshot(c, s3.id, KEY)))!).toMatchObject({ status: 'invalid', rowMismatches: [{ kind: 'account', id: other }] });
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

  it('a forgery with a correctly computed canonical hash (the algorithm is public) but no key does not verify', async () => {
    const { c } = await books();
    const { snapshotHash, SNAPSHOT_CAVEAT } = await import('../../src/modules/accounting/services/audit/documents');
    const { materialHash } = await import('../../src/modules/accounting/services/audit/canonical');
    const row = { id: crypto.randomUUID(), entry_date: '2026-06-01', description: 'invented' };
    const id = await recordSnapshot(pool, o, c, (t) => {
      const base = payload(c, o, t, { key_id: KEY.keyId, caveat: SNAPSHOT_CAVEAT });
      const hash = snapshotHash({ id: base.id, companyId: c, cutoff: base.cutoff, takenAt: t, takenBy: o, trigger: 'manual',
        caveat: SNAPSHOT_CAVEAT, masterDataHighWater: null, totals: {}, checkRun: null }, [],
        [{ journalId: row.id, materialHash: materialHash(row) }], []);
      return { ...base, canonical_hash: hash };
    }, { journals: [{ journal_id: row.id, entry_date: row.entry_date, row, material_hash: materialHash(row) }] });
    const v = (await read(c, () => verifySnapshot(c, id, KEY)))!;
    expect(v.recomputedHash).toBe(v.canonicalHash);
    expect([v.status, v.seal]).toEqual(['invalid', 'invalid']);
  });

  it('a snapshot recorded through the writer without the key never verifies; a genuine one verifies under a retired key, not under an unheld id', async () => {
    const { c } = await books();
    const forged = await recordSnapshot(pool, o, c, (t) => payload(c, o, t, { key_id: KEY.keyId }));
    expect((await read(c, () => verifySnapshot(c, forged, KEY)))!.status).toBe('invalid');
    const s = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    expect((await read(c, () => verifySnapshot(c, s.id, { key: Buffer.from('o'.repeat(48)), keyId: 'other', retired: new Map([[KEY.keyId, { key: KEY.key, retiredAt: Date.now() + 3_600_000 }]]) })))!.status).toBe('valid');
    expect((await read(c, () => verifySnapshot(c, s.id, { key: Buffer.from('o'.repeat(48)), keyId: 'other' })))!.status).toBe('invalid');
    expect((await read(c, () => verifySnapshot(c, s.id, { key: Buffer.from('t'.repeat(48)), keyId: KEY.keyId })))!.status).toBe('invalid');
  });
});

describe('the chain', { timeout: 120_000 }, () => {
  it('numbers each company\'s sealed snapshots and links each to the one before; a removed middle one breaks it', async () => {
    const { c } = await books();
    const ids: string[] = [];
    for (const cutoff of ['2026-04-30', '2026-05-31', '2026-06-30']) ids.push((await takeSnapshot(principal(c), { cutoff, trigger: 'manual' })).id);
    const { rows } = await pool.query("SELECT id::text AS id, seq, prev_hmac, hmac FROM audit_snapshots WHERE company_id = $1 ORDER BY seq", [c]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect([rows[0].prev_hmac, rows[1].prev_hmac, rows[2].prev_hmac]).toEqual([null, rows[0].hmac, rows[1].hmac]);
    expect((await read(c, () => verifyChain(c, KEY))).status).toBe('valid');
    // The owner removes the May snapshot with the guards off (what injected SQL after RESET ROLE could do).
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      for (const t of ['audit_snapshots', 'audit_snapshot_tb', 'audit_snapshot_journals', 'audit_snapshot_lines']) {
        await db.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t}_append_only`);
      }
      await db.query('DELETE FROM audit_snapshots WHERE id = $1', [ids[1]]);
      for (const t of ['audit_snapshots', 'audit_snapshot_tb', 'audit_snapshot_journals', 'audit_snapshot_lines']) {
        await db.query(`ALTER TABLE ${t} ENABLE ALWAYS TRIGGER ${t}_append_only`);
      }
      await db.query('COMMIT');
    } finally { db.release(); }
    const chain = await read(c, () => verifyChain(c, KEY));
    expect(chain.status).toBe('broken');
    expect(chain.breaks.map((b) => b.seq)).toEqual([3]);
    // Each remaining snapshot on its own still verifies: only the chain shows the removal.
    expect((await read(c, () => verifySnapshot(c, ids[2]!, KEY)))!.status).toBe('valid');
  });

  it('a forged link written through the writer is skipped: the next genuine one names the last verifying link (breaker r2 N2)', async () => {
    const { c } = await books();
    const first = await takeSnapshot(principal(c), { cutoff: '2026-04-30', trigger: 'manual' });
    // Through the writer with the owner's claims but without the key: numbered 2, naming link 1 — its seal is made up.
    const forged = await recordSnapshot(pool, o, c, (t) => payload(c, o, t, { key_id: KEY.keyId }));
    const second = await takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    const { rows } = await pool.query('SELECT id::text AS id, seq, prev_hmac, hmac FROM audit_snapshots WHERE company_id = $1 ORDER BY seq', [c]);
    expect(rows.map((r) => [r.id, r.seq])).toEqual([[first.id, 1], [forged, 2], [second.id, 3]]);
    expect(rows[2].prev_hmac).toBe(rows[0].hmac);
    const chain = await read(c, () => verifyChain(c, KEY));
    expect(chain).toMatchObject({ status: 'valid', length: 2, head: { seq: 3, snapshotId: second.id }, breaks: [],
      forged: [{ seq: 2, snapshotId: forged }] });
  });

  it('a link taken no later than the one before it breaks the chain — a backdated row under a key (blind r3 L1)', async () => {
    const { c } = await books();
    await takeSnapshot(principal(c), { cutoff: '2026-04-30', trigger: 'manual' });
    const second = await takeSnapshot(principal(c), { cutoff: '2026-05-31', trigger: 'manual' });
    const { rows: [head] } = await pool.query('SELECT hmac FROM audit_snapshots WHERE id = $1', [second.id]);
    // Someone holding the key writes past the writer (as the owner) with taken_at set back a year.
    const id = crypto.randomUUID();
    const takenAt = '2025-06-01T00:00:00.000000Z';
    const fields = { companyId: c, id, canonicalHash: 'a'.repeat(64), cutoff: '2026-06-30', takenAt, chain: { seq: 3, prevHmac: head.hmac as string } };
    const { hmac } = sign(SNAPSHOT_SEAL_DOMAIN, fields, KEY);
    await pool.query(
      `INSERT INTO audit_snapshots (id, company_id, cutoff, taken_at, taken_by, channel, trigger, status, canonical_hash, hmac, key_id,
         totals, caveat, seq, prev_hmac) VALUES ($1, $2, '2026-06-30', $3, $4, 'session', 'manual', 'sealed', $5, $6, $7, '{}', 'c', 3, $8)`,
      [id, c, takenAt, o, 'a'.repeat(64), hmac, KEY.keyId, head.hmac]);
    const chain = await read(c, () => verifyChain(c, KEY));
    expect(chain.status).toBe('broken');
    expect(chain.breaks).toEqual([expect.objectContaining({ seq: 3, reason: expect.stringMatching(/backdated/) })]);
  });

  it('a second snapshot asked for by hand while one runs for the company is refused, not queued', async () => {
    const { c } = await books();
    const first = takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 150));
    await expect(takeSnapshot(principal(c), { cutoff: '2026-06-30', trigger: 'manual' })).rejects.toBeInstanceOf(SnapshotBusyError);
    await first;
  });
});

describe('checks inside a snapshot', { timeout: 120_000 }, () => {
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
