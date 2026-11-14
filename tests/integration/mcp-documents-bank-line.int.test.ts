/**
 * The MCP document tools with a bank line as the entity, against real Postgres: attach_entity_document files a receipt
 * on a bank line (routed to the bank-tx store), list_documents lists it back by entity_type + entity_id, and the id it
 * returns is the one get_document reads. attach_document keeps writing the same store. Company-fenced throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { attachEntityDocumentTool } from '@/lib/mcp/tools/writeAttachEntityDocument';
import { attachDocumentTool } from '@/lib/mcp/tools/writeAttachDocument';
import { getDocumentTool, listDocumentsTool, listUnsupportedTransactionsTool } from '@/lib/mcp/tools/documents';
import { listMissingDocuments } from '@/modules/accounting/services/core/missingDocumentsService';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { dropDocuments } from './helpers/documentFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describeIfDb('MCP document tools: a bank line is an entity type', () => {
  let fx: Fixture;
  let other: Fixture;
  let tx: string;
  let txOther: string;
  const ctxFor = (f: Fixture, scopes: string[]): McpToolContext =>
    ({ userId: f.userId, companyId: f.companyId, scopes, tokenJti: 'j', oauthAppId: null });
  const writer = () => ctxFor(fx, ['write:invoices', 'write:bank-tx']);
  const reader = () => ctxFor(fx, ['read:reports', 'read:bank-tx']);
  const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  const attach = (over: Record<string, unknown> = {}, ctx = writer()) => attachEntityDocumentTool.handler({
    entity_type: 'bank_transaction', entity_id: tx, file_name: 'receipt.png', mime_type: 'image/png',
    content: PNG.toString('base64'), idempotency_key: 'k', ...over,
  }, ctx);

  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, bank lines and attachments.');
    fx = await seedFixture('MCPBANKDOC', DATABASE_URL!);
    other = await seedFixture('MCPBANKDOCB', DATABASE_URL!);
    tx = await seedBankTx(fx, { date: '2026-06-15', amount: -250, description: 'doc line' });
    txOther = await seedBankTx(other, { date: '2026-06-15', amount: -250, description: 'their line' });
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      if (!f) continue;
      await dropDocuments(f);
      await dropFixture(f);
    }
  }, 120000);

  it('files a receipt on the line, lists it by entity, and get_document reads the same id', async () => {
    const missing = () => listMissingDocuments({
      companyId: fx.companyId, types: ['bank_transaction'], from: '2026-06-01', to: '2026-06-30', minAmount: 0, limit: 10, after: null,
    });
    expect((await missing()).rows.map((r) => r.entityId)).toEqual([tx]);

    const stored = await attach();
    expect(stored.isError).toBeFalsy();
    const doc = json(stored);
    expect(doc).toMatchObject({ entity_type: 'bank_transaction', entity_id: tx, file_name: 'receipt.png', duplicate: false });

    const listed = json(await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: tx }, reader()));
    const rows = listed.rows as Record<string, unknown>[];
    expect(rows.map((r) => r.id)).toEqual([doc.document_id]);
    expect(rows[0]).toMatchObject({ store: 'bank_attachment', entity_type: 'bank_transaction', entity_id: tx });

    const fetched = json(await getDocumentTool.handler({ document_id: String(doc.document_id), include_content: true }, reader()));
    expect(fetched).toMatchObject({ id: doc.document_id, bank_transaction_id: tx, mime_type: 'image/png' });
    expect(Buffer.from(String(fetched.content), 'base64').equals(PNG)).toBe(true);

    expect((await missing()).rows).toEqual([]);
    const unsupported = json(await listUnsupportedTransactionsTool.handler({ from: '2026-06-01', to: '2026-06-30' }, reader()));
    expect((unsupported.rows as unknown[]).length).toBe(0);
  });

  it('a re-run with the same file stores nothing and returns the existing one', async () => {
    const before = Number((await sql`SELECT count(*) AS n FROM bank_transaction_attachments WHERE bank_transaction_id = ${tx}::UUID`)[0]!.n);
    const again = json(await attach());
    expect(again.duplicate).toBe(true);
    expect(Number((await sql`SELECT count(*) AS n FROM bank_transaction_attachments WHERE bank_transaction_id = ${tx}::UUID`)[0]!.n)).toBe(before);
  });

  it('attach_document and attach_entity_document write the same store, listed together', async () => {
    const viaOld = await attachDocumentTool.handler({
      transaction_id: tx, file_name: 'second.png', mime_type: 'image/png', content: PNG.toString('base64'), idempotency_key: 'k2',
    }, writer());
    expect(viaOld.isError).toBeFalsy();
    const listed = json(await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: tx }, reader()));
    expect((listed.rows as Record<string, unknown>[]).map((r) => r.file_name).sort()).toEqual(['receipt.png', 'second.png']);
  });

  it('never reaches another company\'s line, for writing or reading, and says only "Not found"', async () => {
    const write = await attach({ entity_id: txOther });
    expect(write.isError).toBe(true);
    expect(write.content[0]!.text).toBe('Not found');
    const read = await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: txOther }, reader());
    expect(read.isError).toBe(true);
    expect(read.content[0]!.text).toBe('Not found');
    expect(Number((await sql`SELECT count(*) AS n FROM bank_transaction_attachments WHERE bank_transaction_id = ${txOther}::UUID`)[0]!.n)).toBe(0);
    // And company B's token does not see company A's line either.
    const theirs = await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: tx }, ctxFor(other, ['read:reports', 'read:bank-tx']));
    expect(theirs.content[0]!.text).toBe('Not found');
  });

  it('refuses without write:bank-tx, and refuses a docx, before writing', async () => {
    const before = Number((await sql`SELECT count(*) AS n FROM bank_transaction_attachments WHERE bank_transaction_id = ${tx}::UUID`)[0]!.n);
    const noScope = await attach({ file_name: 'third.png' }, ctxFor(fx, ['write:invoices']));
    expect(noScope.isError).toBe(true);
    expect(noScope.content[0]!.text).toContain('write:bank-tx');
    const docx = await attach({
      file_name: 'x.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: Buffer.from('504b0304', 'hex').toString('base64'),
    });
    expect(docx.isError).toBe(true);
    expect(Number((await sql`SELECT count(*) AS n FROM bank_transaction_attachments WHERE bank_transaction_id = ${tx}::UUID`)[0]!.n)).toBe(before);
  });
});
