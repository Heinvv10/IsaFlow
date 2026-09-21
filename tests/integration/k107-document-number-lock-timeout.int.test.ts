/**
 * The counter row wait is BOUNDED. Blind review r3, the caveat on L3.
 *
 * `reserveNextDocumentNumber` is an `UPDATE company_document_numbers SET
 * next_number = next_number + 1 ... RETURNING`, so the row lock is held until
 * the reserving request COMMITs. That serialisation is inherent to a gapless
 * per-company sequence and is accepted. What was not acceptable is that nothing
 * sets `lock_timeout`: one slow or stuck request holding the row blocked every
 * other document creation for that company for as long as it ran, with no
 * error and no 409 — the other requests simply hung.
 *
 * 5s and a typed error, matching recurringTemplateLock, bankTxLock,
 * creditNoteLock, supplierInvoiceLock and the approve paths, so every contended
 * write answers contention the same way.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  DocumentNumberLockTimeoutError,
  ensureDocumentNumbers,
  reserveNextDocumentNumber,
} from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 lock-timeout fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('gives the blocked caller a typed error instead of hanging behind a stuck holder', async () => {
  const holder = await pool.connect(), blocked = await pool.connect();
  try {
    await holder.query('BEGIN');
    await blocked.query('BEGIN');
    // The holder reserves and then stalls, exactly as a slow request would.
    await als.run(ctxFor(holder), () => reserveNextDocumentNumber(company, 'customer_invoice'));

    const startedAt = Date.now();
    const err = await als
      .run(ctxFor(blocked), () => reserveNextDocumentNumber(company, 'customer_invoice'))
      .then(() => null, (e: unknown) => e);
    const waited = Date.now() - startedAt;

    expect.soft(err).toBeInstanceOf(DocumentNumberLockTimeoutError);
    expect.soft((err as DocumentNumberLockTimeoutError).documentType).toBe('customer_invoice');
    // Bounded: it waited the 5s and then gave up, rather than waiting forever.
    expect.soft(waited).toBeGreaterThanOrEqual(4900);
    expect(waited).toBeLessThan(15000);

    await blocked.query('ROLLBACK');
    await holder.query('ROLLBACK');
  } finally {
    holder.release(); blocked.release();
  }
}, 30000);

it('restores the default timeout on the success path, so it does not leak onto later statements', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run(ctxFor(client), () => reserveNextDocumentNumber(company, 'customer_invoice'));
    // Left at 5s, an unrelated later write in the same request would fail for a
    // reason that has nothing to do with document numbering.
    const shown = await client.query('SHOW lock_timeout');
    expect(shown.rows[0].lock_timeout).toBe('0');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
