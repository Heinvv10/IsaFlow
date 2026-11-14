/**
 * POP inbox phase 1 on real PostgreSQL (migration 989 + popIngest.ingestAbsaPop on the cron path):
 *   - a notice is filed once: proof_of_payments row + captured_documents row ('proof_of_payment', 'processed');
 *   - the same notice again (same bytes, or re-encoded bytes with the same ABSA transaction number) files nothing;
 *   - two scans filing one transaction number at once leave ONE pop row and ONE document (the loser rolls back);
 *   - a genuine notice addressed to a profile the company does not trust files nothing;
 *   - app_user sees no other company's rows and cannot UPDATE or DELETE a notice (42501).
 * Storage and the PDF text layer are stubbed (no object store in CI; absaPopParser.test.ts proves the read).
 *
 * Fixture route: isaflow_test (assertNotProductionDb).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { Attachment } from 'mailparser';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';

const h = vi.hoisted(() => ({ text: '', gate: null as null | { waiting: number; open: () => void; opened: Promise<void> } }));
/** Holds each scan inside its transaction (after its document insert) until `size` scans are there. */
function gateFor(size: number): void {
  let open = () => undefined as void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  h.gate = { waiting: 0, open: () => { if (++h.gate!.waiting >= size) open(); }, opened };
}
vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documentStorage')>()),
  storeCapturedBytes: vi.fn(async (_c: string, documentId: string) => {
    if (h.gate) { h.gate.open(); await h.gate.opened; }
    return { documentId, bucket: 'test', path: `pop/${documentId}` };
  }),
}));
vi.mock('@/modules/accounting/services/capture/pop/pdfText', () => ({ pdfText: vi.fn(async () => h.text) }));

import { ingestAbsaPop } from '@/modules/accounting/services/capture/pop/popIngest';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url, max: 3 });
const [A, B] = [crypto.randomUUID(), crypto.randomUUID()];

const notice = (txn: string, payer = 'Example Trading  PTY LTD') => `Notice of Payment 13 November 2026
Absa Bank Limited
Dear ${payer}
Transaction number: ${txn}
Payment date: 2026-11-13
Payment made from: EXAMPLE MAIN
Payment made to: JANE Q PUBLIC
Beneficiary bank name: CAPITEC
For the amount of: 3 000.00
Reference on beneficiary statement: Example Ref`;
const pdf = (tag: string): Attachment => ({ content: Buffer.from(`%PDF-1.4 ${tag} ${crypto.randomUUID()}`), contentType: 'application/pdf' } as Attachment);

async function counts(company: string, txn: string): Promise<{ pops: number; docs: number }> {
  const pops = await pool.query('SELECT captured_document_id FROM proof_of_payments WHERE company_id = $1 AND transaction_number = $2', [company, txn]);
  const docs = await pool.query("SELECT id FROM captured_documents WHERE company_id = $1 AND document_type = 'proof_of_payment' AND file_name = $2",
    [company, `ABSA POP ${txn}.pdf`]);
  return { pops: pops.rowCount ?? 0, docs: docs.rowCount ?? 0 };
}

describeIfDb('POP inbox: filing ABSA notices', () => {
  beforeAll(async () => {
    assertNotProductionDb('pop-inbox-ingest inserts companies, captured documents and proofs of payment');
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [A, 'POP A', B, 'POP B']);
    // Stored with different spacing and case than the notices print: the match ignores both.
    await pool.query("INSERT INTO pop_trusted_payers (company_id, profile_name) VALUES ($1, 'EXAMPLE TRADING PTY LTD'), ($2, 'example trading pty ltd')", [A, B]);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM proof_of_payments WHERE company_id = ANY($1)', [[A, B]]);
      await pool.query('DELETE FROM pop_trusted_payers WHERE company_id = ANY($1)', [[A, B]]);
      await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1)', [[A, B]]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[A, B]]);
    } finally {
      await pool.end();
    }
  });

  it('files a notice once, and nothing for the same bytes or the same transaction number again', async () => {
    h.text = notice('80AB12CD34-11');
    const first = pdf('one');
    const r = await ingestAbsaPop(A, first);
    expect(r.filed).toBe(true);
    const row = (await pool.query(`SELECT p.payment_date::text AS d, p.amount::text AS amount, p.beneficiary, p.source,
        cd.status, cd.document_type, cd.storage_path, cd.extracted_data->'proofOfPayment'->>'transactionNumber' AS txn
      FROM proof_of_payments p JOIN captured_documents cd ON cd.id = p.captured_document_id AND cd.company_id = p.company_id
      WHERE p.company_id = $1`, [A])).rows[0];
    expect(row).toMatchObject({ d: '2026-11-13', amount: '3000.00', beneficiary: 'JANE Q PUBLIC', source: 'absa_notice',
      status: 'processed', document_type: 'proof_of_payment', txn: '80AB12CD34-11' });
    expect(row.storage_path).toMatch(/^pop\//);

    expect(await ingestAbsaPop(A, first)).toEqual({ filed: false, reason: 'duplicate' });
    expect(await ingestAbsaPop(A, pdf('re-encoded'))).toEqual({ filed: false, reason: 'duplicate' });
    expect(await counts(A, '80AB12CD34-11')).toEqual({ pops: 1, docs: 1 });

    // Another company's identical transaction number is its own notice.
    expect((await ingestAbsaPop(B, pdf('b'))).filed).toBe(true);
  });

  it('files nothing for a genuine notice addressed to a payer the company does not trust', async () => {
    h.text = notice('80STRANGER-01', 'SOMEONE ELSE (PTY) LTD');
    expect(await ingestAbsaPop(A, pdf('stranger'))).toEqual({ filed: false, reason: 'payer_not_trusted' });
    expect(await counts(A, '80STRANGER-01')).toEqual({ pops: 0, docs: 0 });
  });

  it('leaves one notice and one document when two scans file the same transaction at once', async () => {
    h.text = notice('80RACE0001-12');
    gateFor(2); // both past the pre-check and inside their transactions before either inserts the POP row
    const results = await Promise.all([ingestAbsaPop(A, pdf('x')), ingestAbsaPop(A, pdf('y'))])
      .finally(() => { h.gate = null; });
    expect(results.filter((r) => r.filed)).toHaveLength(1);
    expect(results.filter((r) => !r.filed)).toEqual([{ filed: false, reason: 'duplicate' }]);
    expect(await counts(A, '80RACE0001-12')).toEqual({ pops: 1, docs: 1 });
  });

  it('app_user sees no other company\'s notices and cannot edit or delete one', async () => {
    const client = await pool.connect();
    try {
      for (const [stmt, expected] of [
        ['SELECT id FROM proof_of_payments WHERE company_id = $1', 'rows'],
        ["UPDATE proof_of_payments SET beneficiary = 'X' WHERE company_id = $1", '42501'],
        ['DELETE FROM proof_of_payments WHERE company_id = $1', '42501'],
      ] as const) {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_user');
        await client.query("SELECT set_config('app.current_company_id', $1, true)", [B]);
        try {
          const res = await client.query(stmt, [A]);
          expect(expected).toBe('rows');
          expect(res.rowCount).toBe(0);
        } catch (err) {
          expect((err as { code?: string }).code).toBe(expected);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      client.release();
    }
  });
});
