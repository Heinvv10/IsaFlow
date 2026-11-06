// tests/integration/supplier-statement-document-insert.int.test.ts
//
// POST /api/accounting/supplier-statements 500'd on production for every company:
// its captured_documents INSERT named mime_type, source and created_by, none of
// which exist. This runs the insert against the real (baseline) schema.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { insertStatementDocument } from '../../src/modules/accounting/services/capture/supplierStatementDocument';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('supplier statement upload — captured_documents insert', () => {
  let fx: Fixture;
  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('stmt-doc-insert');
  });
  afterAll(async () => {
    await fx?.pool.query('DELETE FROM captured_documents WHERE company_id = $1', [ids.A]);
    await tearDownFixture(fx?.pool);
  });

  it('inserts a PDF and an image statement row scoped to the company and uploader', async () => {
    const pdf = await insertStatementDocument(ids.A, ids.USER, 'a.pdf', 'application/pdf');
    const png = await insertStatementDocument(ids.A, ids.USER, 'b.png', 'image/png');
    const { rows } = await fx.pool.query(
      'SELECT id, file_type, document_type, status, uploaded_by, company_id FROM captured_documents WHERE company_id = $1 ORDER BY file_name',
      [ids.A]);
    expect(rows.map((r) => [r.id, r.file_type, r.document_type, r.status, r.uploaded_by, r.company_id]))
      .toEqual([
        [pdf, 'pdf', 'statement', 'pending', ids.USER, ids.A],
        [png, 'png', 'statement', 'pending', ids.USER, ids.A],
      ]);
  });
});
