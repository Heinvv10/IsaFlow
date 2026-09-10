/**
 * R-075 r2 — after-commit callbacks scope themselves to the tenant.
 *
 * Drained callbacks run on the pool's privileged role with no RLS GUCs, so a
 * bare primary key in their UPDATE has nothing behind it. `afterCommit.ts`'s
 * header states the invariant; this file proves it by outcome for the three
 * callbacks that update by id, in both directions: given another company's
 * scope the statement must write NOTHING, and given its own it must still write.
 *
 * Two of the three tables carry no company_id and are scoped through a parent,
 * exactly as their own RLS policies are — so the wrong-tenant case is driven
 * with a foreign parent, not a foreign column value.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const EXTRACTED = { vendorName: 'R075 r2', totalAmount: 1, confidence: 0.9 };
vi.mock('@/modules/accounting/services/core/ocrService', () => ({
  extractFromText: async () => EXTRACTED,
  extractFromPdf: async () => EXTRACTED,
  extractFromImage: async () => EXTRACTED,
}));
vi.mock('@/modules/accounting/services/bank/vlmService', () => ({
  isVlmAvailable: () => true,
  extractStatutoryDocWithVlm: async () => ({ documentType: 'cipc', confidence: 0.9 }),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const coA = randomUUID(), coB = randomUUID();
const user = randomUUID();
const PNG_URL = 'data:image/png;base64,iVBORw0KGgo=';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** ids of the rows that belong to company A — the target of every call below. */
let attachmentId = '', companyDocId = '', procDocId = '';
const entityA = randomUUID(), entityB = randomUUID();

beforeAll(async () => {
  await pool.query("INSERT INTO users (id,email,role,is_active) VALUES ($1,$2,'admin',true)",
    [user, `r075r2-${user}@test.local`]);
  await pool.query('INSERT INTO companies (id,name) VALUES ($1,$2),($3,$4)',
    [coA, 'R075r2 A', coB, 'R075r2 B']);

  const acct = await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
       normal_balance, is_active) VALUES ($1,'1000','R075r2 Bank','asset','bank','debit',true) RETURNING id`,
    [coA]);
  const tx = await pool.query(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
     VALUES ($1,$2,'2026-03-10',-10,'R075r2','imported') RETURNING id`, [coA, acct.rows[0].id]);
  attachmentId = (await pool.query(
    `INSERT INTO bank_transaction_attachments (bank_transaction_id, file_url, file_name, file_size, uploaded_by)
     VALUES ($1,$2,'r075r2.png',8,$3) RETURNING id`, [tx.rows[0].id, PNG_URL, user])).rows[0].id;

  companyDocId = (await pool.query(
    `INSERT INTO company_documents (company_id, document_type, document_name, file_data, mime_type, file_size, uploaded_by)
     VALUES ($1,'cipc_certificate','R075r2',$2,'image/png',8,$3) RETURNING id`, [coA, PNG_URL, user])).rows[0].id;

  procDocId = (await pool.query(
    `INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, mime_type, file_size)
     VALUES ('supplier_invoice',$1,'other','R075r2','image/png',8) RETURNING id`, [entityA])).rows[0].id;
});

afterAll(async () => {
  await pool.query('DELETE FROM procurement_documents WHERE id = $1', [procDocId]);
  await pool.query('DELETE FROM company_documents WHERE company_id = ANY($1::uuid[])', [[coA, coB]]);
  await pool.query(
    'DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id = ANY($1::uuid[]))',
    [[coA, coB]]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1::uuid[])', [[coA, coB]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::uuid[])', [[coA, coB]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[coA, coB]]);
  await pool.query('DELETE FROM users WHERE id = $1', [user]);
  await pool.end();
});

async function extracted(table: string, id: string) {
  return (await pool.query(`SELECT extracted_data FROM ${table} WHERE id = $1`, [id])).rows[0].extracted_data;
}

/** Each callback, its table+row, and the scope arguments for the wrong / right tenant. */
const cases: Array<{
  name: string; table: string; id: () => string;
  run: (scope: 'foreign' | 'own') => Promise<unknown>;
}> = [
  {
    name: 'bank tx attachment extraction (scoped through bank_transactions)',
    table: 'bank_transaction_attachments', id: () => attachmentId,
    run: async (scope) => {
      const { extractAttachmentData } = await import('../../pages/api/accounting/bank-tx-attachments');
      return extractAttachmentData(PNG_URL, 'image/png', attachmentId, scope === 'own' ? coA : coB);
    },
  },
  {
    name: 'statutory doc extraction (company_id column)',
    table: 'company_documents', id: () => companyDocId,
    run: async (scope) => {
      const { extractStatutoryDocData } = await import('../../pages/api/accounting/company-documents');
      return extractStatutoryDocData(PNG_URL, 'cipc_certificate', companyDocId, scope === 'own' ? coA : coB);
    },
  },
  {
    name: 'procurement document extraction (scoped through entity_type/entity_id)',
    table: 'procurement_documents', id: () => procDocId,
    run: async (scope) => {
      const { extractAndStoreDocMetadata } =
        await import('@/modules/accounting/services/core/documentStorageService');
      return extractAndStoreDocMetadata(PNG, 'image/png', procDocId,
        'supplier_invoice', scope === 'own' ? entityA : entityB);
    },
  },
];

describe.each(cases)('$name', ({ table, id, run }) => {
  beforeEach(async () => {
    await pool.query(`UPDATE ${table} SET extracted_data = NULL WHERE id = $1`, [id()]);
  });

  it("another company's scope writes nothing", async () => {
    await run('foreign');
    expect(await extracted(table, id())).toBeNull();
  });

  it('its own scope still writes — the guard is not simply blocking everything', async () => {
    await run('own');
    expect(await extracted(table, id())).not.toBeNull();
  });
});
