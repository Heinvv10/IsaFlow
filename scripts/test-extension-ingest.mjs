/**
 * End-to-end test of the bank-feed extension ingest pipeline (no Chrome needed).
 *
 *   1. Create / reuse a `provider='extension'` connection on a known
 *      test company + bank account
 *   2. Mint a pairing JWT via signExtensionToken
 *   3. POST a small batch of fixture transactions to /extension-ingest
 *   4. Re-POST the same batch — confirm dedup kicks in
 *   5. Print the rows that landed in bank_transactions (filter on
 *      source_filename = 'extension/...')
 *
 * Tears down test rows at the end so the script is idempotent.
 *
 *   bun scripts/test-extension-ingest.mjs
 */

import 'dotenv/config';
import pg from 'pg';
import { signExtensionToken } from '../src/lib/auth/extensionJwt.ts';

const COMPANY_ID = '00000000-0000-0000-0000-0000000d4e02'; // IsaDemo2
// gl_accounts.id (account_subtype='bank'); this is what the IsaFlow UI
// dropdown returns and what bank_transactions.bank_account_id FKs to.
const BANK_ACCOUNT_ID = 'b58e8520-7919-4c30-a72e-dccfe9095de2';
const BANK_ID = 'absa';
const EXTERNAL_ACCT = '0000099999';
const SOURCE_FILE_NEEDLE = `extension/${BANK_ID}@`;
const HOST = process.env.TEST_HOST || 'http://localhost:3200';

// IsaDemo2 owner — must exist in company_users for that company so RLS lets
// the middleware's SELECT see the connection row under role app_user.
const TEST_USER_ID = 'a0000000-0000-0000-0000-000000000001';

const fixtureBatch = (fromDate, toDate) => ({
  scraperId: BANK_ID,
  scraperVersion: '1.0.0-test',
  bankAccountExternalId: EXTERNAL_ACCT,
  fromDate,
  toDate,
  applyBankRules: false,
  transactions: [
    { transactionDate: '2026-04-28', amount: -51745.00, description: 'TEST DIGITAL PAYMENT DT Sample Vendor', balance: 5446.28, reference: 'Sample Vendor' },
    { transactionDate: '2026-04-28', amount:  52000.00, description: 'TEST DIGITAL PAYMENT CR Inbound Transfer', balance: 57191.28 },
    { transactionDate: '2026-04-27', amount:    -14.00, description: 'TEST ARCHIVE STMT ENQ', balance: 5191.28 },
  ],
});

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

async function main() {
  console.log('--- 1. ensure connection row');
  const existing = await q(
    `SELECT id FROM bank_feed_connections
      WHERE company_id=$1 AND bank_account_id=$2 AND provider='extension'
        AND COALESCE(config->>'bankId','') = $3 AND is_active=true
      LIMIT 1`,
    [COMPANY_ID, BANK_ACCOUNT_ID, BANK_ID],
  );

  let connectionId;
  if (existing.length > 0) {
    connectionId = existing[0].id;
    console.log('   reused', connectionId);
  } else {
    const inserted = await q(
      `INSERT INTO bank_feed_connections
         (company_id, bank_account_id, provider, external_account_id, status, config, created_by, is_active)
       VALUES ($1::uuid, $2::uuid, 'extension', $3, 'active', $4::jsonb, $5::uuid, true)
       RETURNING id`,
      [COMPANY_ID, BANK_ACCOUNT_ID, EXTERNAL_ACCT, JSON.stringify({ bankId: BANK_ID }), TEST_USER_ID],
    );
    connectionId = inserted[0].id;
    console.log('   created', connectionId);
  }

  console.log('--- 2. mint JWT');
  const jwt = await signExtensionToken({
    userId: TEST_USER_ID,
    companyId: COMPANY_ID,
    connectionId,
    bankId: BANK_ID,
    scope: 'bank-feed-ingest',
  });
  console.log('   jwt segments:', jwt.split('.').length);

  const ingestUrl = `${HOST}/api/accounting/bank-feeds/${connectionId}/extension-ingest`;
  console.log('   ingest url:', ingestUrl);

  console.log('--- 3. POST first batch (expect imported)');
  const res1 = await fetch(ingestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(fixtureBatch('2026-04-27', '2026-04-29')),
  });
  const json1 = await res1.json().catch(() => null);
  console.log('   status:', res1.status, 'body:', JSON.stringify(json1));
  if (!res1.ok) throw new Error('First ingest failed');

  console.log('--- 4. POST same batch (expect duplicate)');
  const res2 = await fetch(ingestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(fixtureBatch('2026-04-27', '2026-04-29')),
  });
  const json2 = await res2.json().catch(() => null);
  console.log('   status:', res2.status, 'body:', JSON.stringify(json2));

  console.log('--- 5. inspect inserted rows');
  const rows = await q(
    `SELECT bt.transaction_date::text, bt.amount, bt.description, bib.source_filename
       FROM bank_transactions bt
       JOIN bank_import_batches bib ON bib.id = bt.import_batch_id
      WHERE bt.bank_account_id=$1::uuid
        AND bib.source_filename LIKE $2
      ORDER BY bt.transaction_date DESC, bt.id DESC`,
    [BANK_ACCOUNT_ID, SOURCE_FILE_NEEDLE + '%'],
  );
  console.log('   ' + rows.length + ' rows tagged with extension source');
  rows.slice(0, 5).forEach(r => console.log('   ', r.transaction_date, r.amount, '|', r.description.slice(0, 50), '|', r.source_filename));

  console.log('--- 6. inspect sync log');
  const logs = await q(
    `SELECT status, transactions_found, transactions_imported, transactions_duplicate
       FROM bank_feed_sync_logs
      WHERE connection_id=$1::uuid
      ORDER BY started_at DESC LIMIT 3`,
    [connectionId],
  );
  logs.forEach(l => console.log('   log:', JSON.stringify(l)));

  console.log('--- 7. cleanup');
  await q(
    `DELETE FROM bank_transactions
      WHERE bank_account_id=$1::uuid
        AND import_batch_id IN (
          SELECT id FROM bank_import_batches WHERE source_filename LIKE $2
        )`,
    [BANK_ACCOUNT_ID, SOURCE_FILE_NEEDLE + '%'],
  );
  await q(`DELETE FROM bank_import_batches WHERE source_filename LIKE $1`, [SOURCE_FILE_NEEDLE + '%']);
  await q(`DELETE FROM bank_feed_sync_logs WHERE connection_id=$1::uuid`, [connectionId]);
  await q(`DELETE FROM bank_feed_connections WHERE id=$1::uuid`, [connectionId]);
  console.log('   cleaned');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
