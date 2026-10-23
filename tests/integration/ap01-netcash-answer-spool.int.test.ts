/**
 * AP-01 residual 3a: Netcash accepted a send, both bounded settle attempts failed, AND the durable audit_log record
 * failed too (the database is that unwell): only the 500 body and a log line carried the answer, and after a restart
 * resolve could free the row. The answer is now also spooled to local disk (one fsynced JSON line, outside the deploy
 * directory). resolve refuses to FREE a pending row with a spooled acceptance (409 ANSWER_PENDING_RECORD, any process,
 * any restart), and a replay moves spooled answers into audit_log once the database is healthy - exactly once.
 * Judged by outcome: the spool files, audit_log rows, the resolve answers. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';

const hold = vi.hoisted(() => ({ submitEftBatch: vi.fn(), getSubmissionStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => hold);

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { dropLateSettlesForTests } from '@/modules/accounting/services/ap/netcashLateSettler';
import { log } from '@/lib/logger';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { injected, installQueryFaults, resetFaults, faults } from './ap01-netcash-faults.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantApprovedBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
let spool = '';
let restorePg = () => {};
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-SPOOLED' };
const SETTLE_UPDATE = /UPDATE netcash_submissions\s+SET status = \$3, batch_reference = \$4, netcash_response/;

beforeAll(async () => {
  admin = await createUser(pool, tokens);
  restorePg = installQueryFaults();
});
beforeEach(() => {
  hold.submitEftBatch.mockReset(); resetFaults();
  spool = fs.mkdtempSync(path.join(os.tmpdir(), 'netcash-spool-int-'));
  process.env.NETCASH_ANSWER_SPOOL_DIR = path.join(spool, 'spool');
});
afterEach(() => { delete process.env.NETCASH_ANSWER_SPOOL_DIR; vi.restoreAllMocks(); fs.rmSync(spool, { recursive: true, force: true }); });
afterAll(async () => {
  dropLateSettlesForTests();
  restorePg();
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, [admin]);
});

async function fresh() {
  const { company: c, bank } = await payCompany(pool, [[admin, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, b: await plantApprovedBatch(pool, c, admin, bank) };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[admin]!, c, 'POST', { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
/** resolve through a FRESH module graph: a restarted process (no late settler, no in-process state). */
async function resolveAfterRestart(c: string, id: string, outcome = 'failed') {
  vi.resetModules();
  const fresh = (await import('../../pages/api/accounting/netcash/resolve')).default;
  return callRoute(fresh, tokens[admin]!, c, 'POST', { submissionId: id, outcome, note: 'portal shows nothing yet' }, '/api/accounting/netcash/resolve');
}
const status = async (id: string) => (await pool.query('SELECT status FROM netcash_submissions WHERE id = $1', [id])).rows[0].status as string;
const reason = (r: { state: { body: unknown } }) => JSON.stringify(r.state.body).match(/"reason":"([A-Z_]+)"/)?.[1];
/** Pending entries ('.jsonl' in the directory itself), or what is in replayed/ / quarantine/ ('.replayed' / '.quarantined'). */
const spoolFiles = (kind: '.jsonl' | '.replayed' | '.quarantined') => {
  const base = path.join(spool, 'spool');
  const dir = kind === '.jsonl' ? base : path.join(base, kind === '.replayed' ? 'replayed' : 'quarantine');
  return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.jsonl') && !f.startsWith('.'));
};
const auditRows = async (id: string) => (await pool.query(
  "SELECT changes -> 'metadata' AS m, entity_ref FROM audit_log WHERE entity_type = 'netcash_unrecorded_answer' AND entity_id = $1", [id])).rows as
  { m: Record<string, string>; entity_ref: string | null }[];

/** Netcash accepts; both settle attempts fail; the durable audit insert fails too. The late settler is dropped (a restart). */
async function acceptedAndNothingRecorded() {
  const { c, b } = await fresh();
  hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
  faults.rules.push(
    { match: SETTLE_UPDATE, claimOnly: false, act: injected('settle on the claim connection') },
    { match: SETTLE_UPDATE, claimOnly: false, act: injected('settle on the fresh connection') },
    { match: /INSERT INTO audit_log/, claimOnly: false, act: injected('audit insert') },
  );
  const errors = vi.spyOn(log, 'error');
  const res = await submit(c, b.id);
  dropLateSettlesForTests(); // a restart: no settler, no in-process guard
  expect(faults.rules).toEqual([]); // all three failures were consumed: that is the path under test
  const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
  await pool.query("UPDATE netcash_submissions SET created_at = NOW() - INTERVAL '3 minutes' WHERE id = $1", [id]);
  return { c, b, id, res, errors };
}

describe('an accepted answer that not even audit_log could record survives on local disk (AP-01 residual 3a)', () => {
  it('the audit insert fails too: the answer is spooled - one complete fsynced JSON line - and the 500 still says what Netcash answered', async () => {
    const { c, id, res } = await acceptedAndNothingRecorded();
    const files = spoolFiles('.jsonl');
    const line = files.length === 1 ? fs.readFileSync(path.join(spool, 'spool', files[0]!), 'utf8') : '';
    expect({
      http: res.state.statusCode, reason: reason(res), ref: JSON.stringify(res.state.body).includes('NC-SPOOLED'),
      files: files.length, wholeLine: line.endsWith('\n') && line.trim().split('\n').length === 1,
      audit: (await auditRows(id)).length, status: await status(id),
    }).toEqual({ http: 500, reason: 'NETCASH_ANSWER_NOT_RECORDED', ref: true, files: 1, wholeLine: true, audit: 0, status: 'pending' });
    expect(JSON.parse(line)).toMatchObject({
      companyId: c, submissionId: id, metadata: { status: 'submitted', outcome: 'accepted', batchReference: 'NC-SPOOLED' },
    });
    expect(JSON.parse(line).metadata.settleToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(line).metadata.answer).toContain('NC-SPOOLED');
  });

  it('after a restart resolve refuses to FREE the row 409 ANSWER_PENDING_RECORD naming Netcash\'s answer; recording it SUBMITTED is allowed', async () => {
    const { c, b, id } = await acceptedAndNothingRecorded();
    // The database is still unwell for the replay: the spool is all there is.
    faults.rules.push({ match: /INSERT INTO audit_log/, claimOnly: false, act: injected('audit insert (replay)') });
    const free = await resolveAfterRestart(c, id);
    const text = JSON.stringify(free.state.body);
    faults.rules.length = 0;
    expect({ http: free.state.statusCode, reason: reason(free), accepted: /accepted/.test(text), ref: text.includes('NC-SPOOLED'), status: await status(id), spooled: spoolFiles('.jsonl').length })
      .toEqual({ http: 409, reason: 'ANSWER_PENDING_RECORD', accepted: true, ref: true, status: 'pending', spooled: 1 });
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const keep = await resolveAfterRestart(c, id, 'submitted');
    const again = await submit(c, b.id);
    expect({ keep: keep.state.statusCode, status: await status(id), resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length })
      .toEqual({ keep: 200, status: 'submitted', resend: 409, sends: 1 });
  }, 30_000);

  it('once the database is healthy the replay moves the entry into audit_log EXACTLY ONCE (run twice), and the row is still not freeable', async () => {
    const { c, id } = await acceptedAndNothingRecorded();
    const { replaySpooledAnswers } = await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay');
    const first = await replaySpooledAnswers();
    const second = await replaySpooledAnswers();
    const rows = await auditRows(id);
    const free = await resolveAfterRestart(c, id);
    expect({ first, second, audit: rows.length, pending: spoolFiles('.jsonl').length, replayed: spoolFiles('.replayed').length, free: free.state.statusCode, reason: reason(free) })
      .toEqual({ first: 1, second: 0, audit: 1, pending: 0, replayed: 1, free: 409, reason: 'ANSWER_PENDING_RECORD' });
    expect(rows[0]).toMatchObject({ entity_ref: 'NC-SPOOLED', m: { status: 'submitted', outcome: 'accepted', batchReference: 'NC-SPOOLED' } });
  }, 30_000);

  it('a replay that finds its entry already in audit_log (it crashed after the insert, before the rename) adds nothing', async () => {
    const { id } = await acceptedAndNothingRecorded();
    const { replaySpooledAnswers } = await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay');
    // Crash between the insert and the rename: the file comes back as pending after the first replay.
    await replaySpooledAnswers();
    const name = spoolFiles('.replayed')[0]!;
    fs.renameSync(path.join(spool, 'spool', 'replayed', name), path.join(spool, 'spool', name));
    const again = await replaySpooledAnswers();
    expect({ again, audit: (await auditRows(id)).length, pending: spoolFiles('.jsonl').length, replayed: spoolFiles('.replayed').length })
      .toEqual({ again: 1, audit: 1, pending: 0, replayed: 1 });
  }, 30_000);

  it('resolve itself replays a healthy database\'s spool (no cron): the entry reaches audit_log and the row stays refused', async () => {
    const { c, id } = await acceptedAndNothingRecorded();
    const free = await resolveAfterRestart(c, id);
    expect({ http: free.state.statusCode, reason: reason(free), audit: (await auditRows(id)).length, replayed: spoolFiles('.replayed').length })
      .toEqual({ http: 409, reason: 'ANSWER_PENDING_RECORD', audit: 1, replayed: 1 });
  }, 30_000);

  it('a submit replays a healthy database\'s spool too (no cron, not awaited): the entry reaches audit_log and is marked replayed', async () => {
    const { id } = await acceptedAndNothingRecorded();
    const other = await fresh();
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    expect((await submit(other.c, other.b.id)).state.statusCode).toBe(200);
    for (let i = 0; i < 50 && spoolFiles('.jsonl').length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect({ audit: (await auditRows(id)).length, pending: spoolFiles('.jsonl').length, replayed: spoolFiles('.replayed').length })
      .toEqual({ audit: 1, pending: 0, replayed: 1 });
  }, 30_000);

  it('an entry the database refuses for its own content (a deleted user) does not block the entries behind it; after 3 refusals it is quarantined and STILL blocks its submission', async () => {
    const { c, id: goodId } = await acceptedAndNothingRecorded(); // a good entry
    const bad = await fresh();
    const badSub = (await pool.query(
      `INSERT INTO netcash_submissions (company_id, submission_type, batch_reference, total_amount_cents, record_count, status, created_by, created_at)
       VALUES ($1, 'eft_payment', 'BAT-X', 100, 1, 'pending', 'x', NOW() - INTERVAL '3 minutes') RETURNING id`, [bad.c])).rows[0].id as string;
    const token = crypto.randomUUID();
    // The bad entry sorts BEFORE the good one (renamed to start with 'z'): the old replay stopped at it and never reached the good one.
    const goodFile = spoolFiles('.jsonl')[0]!;
    fs.renameSync(path.join(spool, 'spool', goodFile), path.join(spool, 'spool', `zz-${goodFile}`));
    fs.writeFileSync(path.join(spool, 'spool', `${bad.c}.${badSub}.${token}.submitted.jsonl`), `${JSON.stringify({
      v: 1, companyId: bad.c, userId: crypto.randomUUID(), sub: admin, submissionId: badSub, entityRef: 'NC-BAD',
      metadata: { status: 'submitted', outcome: 'accepted', batchReference: 'NC-BAD', settleToken: token, answer: '{}' }, spooledAt: new Date().toISOString(),
    })}\n`);
    const { replaySpooledAnswers } = await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay');
    const warnings = vi.spyOn((await import('@/lib/logger')).log, 'warn');
    const first = await replaySpooledAnswers();
    const afterFirst = { good: (await auditRows(goodId)).length, pending: spoolFiles('.jsonl').length };
    await replaySpooledAnswers();
    const third = await replaySpooledAnswers();
    const blocked = await resolveAfterRestart(bad.c, badSub);
    expect(warnings.mock.calls.some(([, data]) => (data as { code?: string } | undefined)?.code === '23503')).toBe(true); // the SQLSTATE is logged
    expect({ first, afterFirst, third, pendingAfter: spoolFiles('.jsonl').length, quarantined: spoolFiles('.quarantined').length, blocked: blocked.state.statusCode, reason: reason(blocked), c: c.length > 0 })
      .toEqual({ first: 1, afterFirst: { good: 1, pending: 1 }, third: 0, pendingAfter: 0, quarantined: 1, blocked: 409, reason: 'ANSWER_PENDING_RECORD', c: true });
  }, 60_000);

  it('two processes replaying the same entry at once write it to audit_log exactly once (advisory lock on the settle token)', async () => {
    const { id } = await acceptedAndNothingRecorded();
    // Widen the window between the exists-check and the insert in both replayers.
    for (let i = 0; i < 2; i++) {
      faults.rules.push({ match: /netcash_spool_replay_exists/, claimOnly: false, act: async (run) => { const out = await run(); await new Promise((r) => setTimeout(r, 500)); return out; } });
    }
    vi.resetModules();
    const a = (await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay')).replaySpooledAnswers;
    vi.resetModules();
    const b = (await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay')).replaySpooledAnswers; // another "process": its own state
    const [x, y] = await Promise.all([a(), b()]);
    expect({ audit: (await auditRows(id)).length, handled: x + y >= 1, pending: spoolFiles('.jsonl').length, replayed: spoolFiles('.replayed').length })
      .toEqual({ audit: 1, handled: true, pending: 0, replayed: 1 });
  }, 60_000);

  it('REPRO-1 (breaker): another process\'s replay commits audit_log and moves the file between resolve\'s two reads: the accepted row is still refused', async () => {
    const { c, id } = await acceptedAndNothingRecorded();
    // resolve's own replay fails (the database "still unwell"); then, in the gap after its spool read and before/at its
    // audit_log read, another process's replay commits the audit row and moves the file to replayed/.
    faults.rules.push({ match: /INSERT INTO audit_log/, claimOnly: false, act: injected('audit insert (resolve replay)') });
    faults.rules.push({
      match: /ORDER BY a\.created_at DESC/, claimOnly: false,
      act: async (run) => {
        const out = await run(); // audit_log: nothing yet
        vi.resetModules();
        const other = await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay'); // "another process"
        await other.replaySpooledAnswers();
        return out;
      },
    });
    const res = await resolveAfterRestart(c, id);
    expect({ http: res.state.statusCode, reason: reason(res), status: await status(id), audit: (await auditRows(id)).length })
      .toEqual({ http: 409, reason: 'ANSWER_PENDING_RECORD', status: 'pending', audit: 1 });
  }, 60_000);

  it('REPRO-2 (breaker): a second process replays completely before the first inserts: still ONE audit_log row (the lock holds the second off)', async () => {
    const { id } = await acceptedAndNothingRecorded();
    const one = await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay');
    vi.resetModules();
    const two = await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay');
    expect(one).not.toBe(two);
    faults.rules.push({ match: /INSERT INTO audit_log/, claimOnly: false, act: async (run) => { await two.replaySpooledAnswers(); return run(); } });
    await one.replaySpooledAnswers();
    expect({ audit: (await auditRows(id)).length, replayed: spoolFiles('.replayed').length, pending: spoolFiles('.jsonl').length }).toEqual({ audit: 1, replayed: 1, pending: 0 });
  }, 60_000);

  it('an acceptance whose spool write never reached the rename keeps blocking resolve after the stale sweep (and the database being unwell for its replay)', async () => {
    const { c, id } = await acceptedAndNothingRecorded();
    const dirPath = path.join(spool, 'spool');
    const [name] = spoolFiles('.jsonl');
    // The write that "never reached the rename": the complete line sits under its temp name, older than the timeout.
    const temp = path.join(dirPath, `.${name}.${crypto.randomUUID().slice(0, 8)}.tmp`);
    fs.renameSync(path.join(dirPath, name!), temp);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(temp, old, old);
    faults.rules.push({ match: /INSERT INTO audit_log/, claimOnly: false, act: injected('audit insert (replay)') });
    const res = await resolveAfterRestart(c, id); // its replay sweeps the stale temp
    expect({ http: res.state.statusCode, reason: reason(res), swept: !fs.existsSync(temp), pending: spoolFiles('.jsonl').length, status: await status(id) })
      .toEqual({ http: 409, reason: 'ANSWER_PENDING_RECORD', swept: true, pending: 1, status: 'pending' });
    expect((await resolveAfterRestart(c, id)).state.statusCode).toBe(409); // and a minute later, still
  }, 60_000);

  it('a COMPLETE stale temp is REPLAYED like a final entry once the database answers: one audit_log row, then moved to replayed/', async () => {
    const { id } = await acceptedAndNothingRecorded();
    const dirPath = path.join(spool, 'spool');
    const [name] = spoolFiles('.jsonl');
    const temp = path.join(dirPath, `.${name}.${crypto.randomUUID().slice(0, 8)}.tmp`);
    fs.renameSync(path.join(dirPath, name!), temp);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(temp, old, old);
    const { replaySpooledAnswers } = await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay');
    const first = await replaySpooledAnswers();
    const second = await replaySpooledAnswers();
    expect({ first, second, audit: (await auditRows(id)).length, temp: fs.existsSync(temp), pending: spoolFiles('.jsonl').length, replayed: spoolFiles('.replayed').length })
      .toEqual({ first: 1, second: 0, audit: 1, temp: false, pending: 0, replayed: 1 });
  }, 60_000);

  it('a permission error (42501: a deploy-time grant gap) is NOT the entry\'s fault: the entry is never quarantined and replays once the grant is back; a 23503 is logged with its SQLSTATE', async () => {
    const { id } = await acceptedAndNothingRecorded();
    for (let i = 0; i < 4; i++) {
      faults.rules.push({ match: /netcash_spool_replay_exists/, claimOnly: false, act: async () => { throw Object.assign(new Error('permission denied for table audit_log'), { code: '42501' }); } });
    }
    const { replaySpooledAnswers } = await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay');
    for (let i = 0; i < 4; i++) await replaySpooledAnswers();
    expect({ pending: spoolFiles('.jsonl').length, quarantined: spoolFiles('.quarantined').length }).toEqual({ pending: 1, quarantined: 0 });
    faults.rules.length = 0;
    expect(await replaySpooledAnswers()).toBe(1); // the grant is back
    expect({ audit: (await auditRows(id)).length, replayed: spoolFiles('.replayed').length }).toEqual({ audit: 1, replayed: 1 });
  }, 60_000);

  it('REPRO-4 (breaker): a torn STALE temp of a never-sent answer does not block "failed"; a torn one of a submitted answer does, and the 409 names the file and the manual step', async () => {
    const a = await fresh();
    const aSub = (await pool.query(
      `INSERT INTO netcash_submissions (company_id, submission_type, batch_reference, total_amount_cents, record_count, status, created_by, created_at)
       VALUES ($1, 'eft_payment', 'BAT-X', 100, 1, 'pending', 'x', NOW() - INTERVAL '3 minutes') RETURNING id`, [a.c])).rows[0].id as string;
    fs.mkdirSync(path.join(spool, 'spool'), { recursive: true });
    const old = new Date(Date.now() - 10 * 60_000);
    const tornTemp = (status: string, sub: string) => {
      const t = path.join(spool, 'spool', `.${a.c}.${sub}.${crypto.randomUUID()}.${status}.jsonl.${crypto.randomUUID().slice(0, 8)}.tmp`);
      fs.writeFileSync(t, '{"v":1,"companyId":'); fs.utimesSync(t, old, old);
    };
    tornTemp('failed', aSub); // crash mid-write of a FAILED answer: nothing was ever sent
    const first = await resolveAfterRestart(a.c, aSub);
    expect({ http: first.state.statusCode, status: await status(aSub) }).toEqual({ http: 200, status: 'failed' });

    const bSub = (await pool.query(
      `INSERT INTO netcash_submissions (company_id, submission_type, batch_reference, total_amount_cents, record_count, status, created_by, created_at)
       VALUES ($1, 'eft_payment', 'BAT-Y', 100, 1, 'pending', 'x', NOW() - INTERVAL '3 minutes') RETURNING id`, [a.c])).rows[0].id as string;
    tornTemp('submitted', bSub);
    const blocked = await resolveAfterRestart(a.c, bSub); // its replay sweeps it to quarantine/
    const again = await resolveAfterRestart(a.c, bSub);
    const text = JSON.stringify(blocked.state.body);
    expect({ http: blocked.state.statusCode, reason: reason(blocked), again: again.state.statusCode, status: await status(bSub),
      names: /\.stale\.jsonl/.test(text), step: /move that file out of the (answer )?spool directory/i.test(text) })
      .toEqual({ http: 409, reason: 'ANSWER_PENDING_RECORD', again: 409, status: 'pending', names: true, step: true });
  }, 60_000);

  it('a replay is bounded per call: maxEntries leaves the rest for the next call', async () => {
    const { id } = await acceptedAndNothingRecorded(); // one real entry...
    const [name] = spoolFiles('.jsonl');
    const entry = fs.readFileSync(path.join(spool, 'spool', name!), 'utf8');
    for (let i = 0; i < 2; i++) { // ...and two more answers (other tokens) for the same company
      const token = crypto.randomUUID();
      const e = JSON.parse(entry) as { companyId: string; submissionId: string; metadata: Record<string, string> };
      e.metadata.settleToken = token;
      fs.writeFileSync(path.join(spool, 'spool', `${e.companyId}.${e.submissionId}.${token}.submitted.jsonl`), `${JSON.stringify(e)}\n`);
    }
    const { replaySpooledAnswers } = await import('@/modules/accounting/services/ap/netcashAnswerSpoolReplay');
    const moved = await replaySpooledAnswers({ maxEntries: 1 });
    expect({ moved, pending: spoolFiles('.jsonl').length, replayed: spoolFiles('.replayed').length }).toEqual({ moved: 1, pending: 2, replayed: 1 });
    expect(await replaySpooledAnswers()).toBe(2);
    expect((await auditRows(id)).length).toBe(3);
  }, 60_000);

  it('the first submit logs an error, once, when the spool directory is not writable', async () => {
    const blocker = path.join(spool, 'a-file');
    fs.writeFileSync(blocker, 'x');
    process.env.NETCASH_ANSWER_SPOOL_DIR = path.join(blocker, 'spool');
    vi.resetModules();
    const route = (await import('../../pages/api/accounting/netcash/submit')).default;
    const freshLog = (await import('@/lib/logger')).log;
    const errors = vi.spyOn(freshLog, 'error');
    const A = await fresh();
    const B = await fresh();
    hold.submitEftBatch.mockResolvedValue(ACCEPTED);
    for (const x of [A, B]) await callRoute(route, tokens[admin]!, x.c, 'POST', { batchPaymentId: x.b.id }, '/api/accounting/netcash/submit');
    await new Promise((r) => setTimeout(r, 300));
    expect(errors.mock.calls.filter(([m]) => /NOT writable/.test(String(m)))).toHaveLength(1);
  }, 30_000);

  it('the spool directory is unwritable: the request still answers its 500 with the answer in the body, log.error carries it, nothing crashes', async () => {
    const blocker = path.join(spool, 'a-file');
    fs.writeFileSync(blocker, 'x');
    process.env.NETCASH_ANSWER_SPOOL_DIR = path.join(blocker, 'spool');
    const { id, res, errors } = await acceptedAndNothingRecorded();
    expect({
      http: res.state.statusCode, reason: reason(res), ref: JSON.stringify(res.state.body).includes('NC-SPOOLED'),
      logged: errors.mock.calls.some(([, data]) => JSON.stringify(data).includes('NC-SPOOLED') && JSON.stringify(data).includes(id)),
      audit: (await auditRows(id)).length,
    }).toEqual({ http: 500, reason: 'NETCASH_ANSWER_NOT_RECORDED', ref: true, logged: true, audit: 0 });
  }, 30_000);

  it("another company's spooled answer naming this submission does not stop its resolve; an unknown answer does not either", async () => {
    const A = await fresh();
    const B = await fresh();
    const plant = async (c: string) => (await pool.query(
      `INSERT INTO netcash_submissions (company_id, submission_type, batch_reference, total_amount_cents, record_count, status, created_by, created_at)
       VALUES ($1, 'eft_payment', 'BAT-X', 100, 1, 'pending', 'x', NOW() - INTERVAL '3 minutes') RETURNING id`, [c])).rows[0].id as string;
    const spoolEntry = (companyId: string, submissionId: string, st: string) => {
      fs.mkdirSync(path.join(spool, 'spool'), { recursive: true });
      const token = crypto.randomUUID();
      fs.writeFileSync(path.join(spool, 'spool', `${companyId}.${submissionId}.${token}.${st}.jsonl`), `${JSON.stringify({
        v: 1, companyId, userId: admin, sub: admin, submissionId, entityRef: 'NC-OTHER',
        metadata: { status: st, outcome: st === 'submitted' ? 'accepted' : 'unknown', batchReference: 'NC-OTHER', settleToken: token, answer: '{}' }, spooledAt: new Date().toISOString(),
      })}\n`);
    };
    const elsewhere = await plant(A.c);
    spoolEntry(B.c, elsewhere, 'submitted'); // another tenant's entry naming A's submission
    const own = await plant(A.c);
    spoolEntry(A.c, own, 'submitted');
    const unknown = await plant(A.c);
    spoolEntry(A.c, unknown, 'unknown');
    const results = { elsewhere: await resolveAfterRestart(A.c, elsewhere), own: await resolveAfterRestart(A.c, own), unknown: await resolveAfterRestart(A.c, unknown) };
    expect({ elsewhere: results.elsewhere.state.statusCode, own: results.own.state.statusCode, ownReason: reason(results.own), unknown: results.unknown.state.statusCode })
      .toEqual({ elsewhere: 200, own: 409, ownReason: 'ANSWER_PENDING_RECORD', unknown: 200 });
  }, 60_000);
});
