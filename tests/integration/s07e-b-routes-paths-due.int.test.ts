// tests/integration/s07e-b-routes-paths-due.int.test.ts
//
// S-07e part B, review round 4, on a real database and the production logins:
//
// - the cron's due selection (both mirrors) takes SKIP LOCKED, so a connection row another
//   session holds locked never occupies a LIMIT slot, and a future last_scan_at sorts last among
//   the due rows (still due). Round 5: it runs on migration_admin (routeAdminQuery) with FOR NO KEY
//   UPDATE: no app role can lock these rows any more (no UPDATE), the key-share lock of an app
//   role's scan-log INSERT does not hide a row, and breaker5's NULL pin is refused 42501 at the
//   UPDATE (the forged stamps below are therefore set as the owner).
// - isFileAlreadyCaptured (the capture mirror's de-dupe) as the cron runs it: no company claim,
//   scoped by company_id, blind to an unfinished ingest (a 'pending' row with no event), and,
//   since round 5, to a rejected or failed document, so a re-sent copy of it is captured again.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { PoolClient } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { routeAdminPool } from '@/lib/auth/routeAdminPool';
import { listActiveConnections } from '@/modules/accounting/services/capture/imapMirrorService';
import { listActiveSentConnections } from '@/modules/accounting/services/ar/sentMirrorService';
import { isFileAlreadyCaptured } from '@/modules/accounting/services/capture/capturedDocumentHash';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const { company, other } = ids;
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);

const SELECTORS = [
  ['capture mirror', 'imap_mirror_connections', listActiveConnections],
  ['sent mirror', 'sent_mirror_connections', listActiveSentConnections],
] as const;

let seq = 0;
const add = async (table: string, co: string, scanned: string | null): Promise<string> => (await q(
  `INSERT INTO ${table} (company_id, provider, display_name, account_email, status, imap_host, imap_port, imap_use_tls,
      imap_username, imap_password_enc, last_scan_at)
   VALUES ($1, 'imap', 'Due', $2, 'active', 'imap.due.test', 993, true, 'u', 'enc:x', ${scanned === null ? 'NULL' : `NOW() - ${scanned}::interval`})
   RETURNING id`, [co, `due-${++seq}-${crypto.randomUUID().slice(0, 6)}@s07eb.test`])).rows[0].id as string;

beforeAll(async () => { await setup(ids); }, 60000);
afterAll(async () => {
  await q('DELETE FROM captured_documents WHERE company_id = ANY($1)', [[company, other]]);
  for (const [, table] of SELECTORS) await q(`DELETE FROM ${table} WHERE company_id = ANY($1)`, [[company, other]]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool(), routeAdminPool()]);
});

describe.each(SELECTORS)('S-07e part B (946) round 4: %s, the due selection', (_name, table, list) => {
  const listed = async () => (await list()).map((c) => c.id);
  // The selection takes 20 rows: a test's rows must not crowd the next one's out.
  afterEach(async () => { await q(`DELETE FROM ${table} WHERE company_id = ANY($1)`, [[company, other]]); });

  it('a row another session holds locked is skipped and a bystander is listed; once released, it is listed again', async () => {
    const held = await add(table, other, "'1 day'");
    const bystander = await add(table, company, "'2 days'");
    const holder: PoolClient = await fixture.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [held]);
      const during = await listed();
      expect(during).toContain(bystander);
      expect(during).not.toContain(held);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await listed()).toEqual(expect.arrayContaining([held, bystander]));
  }, 30000);

  it('20 locked, future-stamped rows of another tenant do not fill the LIMIT: a due bystander is still listed', async () => {
    const victims: string[] = [];
    for (let i = 0; i < 20; i++) victims.push(await add(table, other, null));
    await q(`UPDATE ${table} SET last_scan_at = '9999-01-01' WHERE id = ANY($1::uuid[])`, [victims]);
    const bystander = await add(table, company, "'3 days'");
    const holder: PoolClient = await fixture.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM ${table} WHERE id = ANY($1::uuid[]) FOR UPDATE`, [victims]);
      for (const _tick of [1, 2, 3]) {
        const during = await listed();
        expect(during).toContain(bystander);
        expect(during.filter((id) => victims.includes(id))).toEqual([]);
      }
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 60000);

  it('breaker5\'s pin: 20 of another tenant\'s rows stamped NULL (or 1970) by an app login is refused 42501; a due bystander is listed', async () => {
    const victims: string[] = [];
    for (let i = 0; i < 20; i++) victims.push(await add(table, other, "'1 minute'"));
    const bystander = await add(table, company, "'2 days'");
    for (const stamp of ['NULL', "'1970-01-01'"]) {
      await expect(getDbPool().query(`UPDATE ${table} SET last_scan_at = ${stamp} WHERE id = ANY($1::uuid[])`, [victims]))
        .rejects.toMatchObject({ code: '42501' });
    }
    const listed1 = await listed();
    expect(listed1).toContain(bystander);
    expect(listed1.filter((id) => victims.includes(id))).toEqual([]); // scanned a minute ago: not due
  }, 60000);

  it('a scan-log row an app login inserts (and holds, uncommitted) does not hide its connection from the selection', async () => {
    const held = await add(table, other, "'1 day'");
    const logTable = table.replace('_connections', '_scan_log');
    const holder = await getDbPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`INSERT INTO ${logTable} (connection_id, company_id, outcome, attachment_count) VALUES ($1, $2, 'error', 0)`, [held, other]);
      expect(await listed()).toContain(held);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 30000);

  it('a future last_scan_at is still due, and sorts after never-scanned and overdue rows', async () => {
    const future = await add(table, company, null);
    await q(`UPDATE ${table} SET last_scan_at = NOW() + interval '30 days' WHERE id = $1`, [future]);
    const overdue = await add(table, company, "'2 days'");
    const never = await add(table, company, null);
    const order = (await listed()).filter((id) => [future, overdue, never].includes(id));
    expect(order).toEqual([never, overdue, future]);
  }, 30000);
});

describe('S-07e part B (946) round 4: the capture mirror\'s de-dupe lookup, as the cron runs it', () => {
  const doc = async (co: string, hash: string, status: string, withEvent: boolean): Promise<string> => {
    const id = (await q(`INSERT INTO captured_documents (company_id, file_name, file_type, file_size, status, raw_bytes_sha256, raw_bytes_size)
      VALUES ($1, 'x.pdf', 'application/pdf', 3, $2, $3, 3) RETURNING id`, [co, status, hash])).rows[0].id as string;
    if (withEvent) await q(`INSERT INTO capture_events (company_id, channel, status, captured_document_id) VALUES ($1, 'imap_mirror', 'received', $2)`, [co, id]);
    return id;
  };

  it('finds an ingested file of this company with no company claim set', async () => {
    await doc(company, 'hash-ingested', 'pending', true);
    expect(await isFileAlreadyCaptured(company, 'hash-ingested')).toBe(true);
  });

  it('finds a finished document that has no capture event (an upload, a sent-mirror capture)', async () => {
    await doc(company, 'hash-uploaded', 'matched', false);
    expect(await isFileAlreadyCaptured(company, 'hash-uploaded')).toBe(true);
  });

  it('does not count an unfinished ingest (pending, no event): the retry of that message must still capture the file', async () => {
    await doc(company, 'hash-orphan', 'pending', false);
    expect(await isFileAlreadyCaptured(company, 'hash-orphan')).toBe(false);
  });

  it('is scoped by company: another tenant holding the same file does not hide it', async () => {
    await doc(other, 'hash-theirs', 'extracted', true);
    expect(await isFileAlreadyCaptured(company, 'hash-theirs')).toBe(false);
    expect(await isFileAlreadyCaptured(other, 'hash-theirs')).toBe(true);
  });

  it.each([
    ['a rejected document', 'rejected', 'done', null],
    ['a document whose read failed', 'matched', 'failed', null],
    ['a mirror capture whose event failed (routing)', 'pending', 'done', 'failed'],
  ])('does not count %s: a re-sent copy of that file is captured again', async (_what, status, readState, eventStatus) => {
    const hash = `hash-${crypto.randomUUID()}`;
    const id = (await q(`INSERT INTO captured_documents (company_id, file_name, file_type, file_size, status, raw_bytes_sha256, raw_bytes_size, read_state)
      VALUES ($1, 'x.pdf', 'application/pdf', 3, $2, $3, 3, $4) RETURNING id`, [company, status, hash, readState])).rows[0].id as string;
    if (eventStatus) await q(`INSERT INTO capture_events (company_id, channel, status, captured_document_id) VALUES ($1, 'imap_mirror', $2, $3)`, [company, eventStatus, id]);
    expect(await isFileAlreadyCaptured(company, hash)).toBe(false);
    // The same file held in good standing alongside it still counts.
    await doc(company, hash, 'matched', false);
    expect(await isFileAlreadyCaptured(company, hash)).toBe(true);
  });

  it('an unknown hash is not captured', async () => {
    expect(await isFileAlreadyCaptured(company, 'hash-never-seen')).toBe(false);
  });
});
