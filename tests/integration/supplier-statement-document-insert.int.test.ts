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
    const pdf = await insertStatementDocument(ids.A, ids.USER, 'a.pdf', 'application/pdf', 1234);
    const png = await insertStatementDocument(ids.A, ids.USER, 'b.png', 'image/png', 56);
    const { rows } = await fx.pool.query(
      'SELECT id, file_type, file_size, document_type, status, uploaded_by, company_id FROM captured_documents WHERE company_id = $1',
      [ids.A]);
    const got = Object.fromEntries(rows.map((r) => [r.id, [r.file_type, r.file_size, r.document_type, r.status, r.uploaded_by, r.company_id]]));
    expect(got).toEqual({
      [pdf]: ['pdf', 1234, 'statement', 'pending', ids.USER, ids.A],
      [png]: ['png', 56, 'statement', 'pending', ids.USER, ids.A],
    });
  });
});
