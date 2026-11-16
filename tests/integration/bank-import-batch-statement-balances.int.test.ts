/**
 * WP1 PR-A: every import path records a statement batch's opening/closing balance, or why it has none
 * (bank_import_batches.balance_source, migration 998), through the real routes and services:
 *   - upload (bulk-commit) and agent import (import_bank_statement): parseStatement derives the figures from the
 *     WHOLE file, before the ledger window and before dedupe, and importParsedTransactions stores them under the
 *     write rule (bankStatementBalances.ts);
 *   - OCR commit: the closing balance the read found, copied as 'printed', or 'not_in_file';
 *   - extension feed and the classified worksheet: 'not_in_file'.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bulkCommit from '../../pages/api/accounting/bank-transactions-bulk-commit';
import importClassified from '../../pages/api/accounting/bank-transactions-import-classified';
import ocrCommit from '../../pages/api/accounting/bank-statements/[id]/commit';
import { importBankStatementTool } from '../../src/lib/mcp/tools/writeBankImport';
import { ingestBankBatch } from '../../src/modules/accounting/services/bank/feed/bankIngestionService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { inRequest } from './r035-pr5.helpers';
import { bankCompany, cleanupBankControlsA, mcpCaller, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let f: BankCompany;
const mcp = mcpCaller(pool, [importBankStatementTool]);

beforeAll(async () => {
  // As bank-controls-import-provenance: import-classified writes a column no migration creates (fixture only).
  await pool.query('ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_cost_centre TEXT');
  a = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin']], companies);
});
afterAll(async () => {
  await pool.query('DELETE FROM bank_feed_sync_logs WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]);
});

type Stored = { opening: string | null; closing: string | null; source: string | null; lines: number };
const stored = async (batchId: string): Promise<Stored> => (await pool.query(
  `SELECT b.opening_balance::TEXT AS opening, b.closing_balance::TEXT AS closing, b.balance_source AS source,
          (SELECT count(*)::INT FROM bank_transactions bt WHERE bt.import_batch_id = b.id AND bt.company_id = b.company_id) AS lines
   FROM bank_import_batches b WHERE b.id = $1 AND b.company_id = $2`, [batchId, f.c])).rows[0] as Stored;

/** An FNB CSV (Date, Description, Amount, Balance, Reference) opening at R1 000.00 and closing at R1 199.79. */
function fnbCsv(tag: string, month: string, opts: { descending?: boolean; breakBalance?: boolean } = {}): string {
  const rows: [string, string, string, string][] = [
    [`2026/${month}/03`, `${tag}1 SALE`, '250.00', '1250.00'],
    [`2026/${month}/04`, `${tag}2 FEE`, '-100.10', opts.breakBalance ? '1148.90' : '1149.90'],
    [`2026/${month}/05`, `${tag}3 SALE`, '49.99', '1199.89'],
    [`2026/${month}/06`, `${tag}4 FEE`, '-0.10', '1199.79'],
  ];
  const lines = rows.map(([d, desc, amt, bal]) => `"${d}","${desc}","${amt}","${bal}","REF${tag}"`);
  return ['"Date","Description","Amount","Balance","Reference"', ...(opts.descending ? lines.reverse() : lines)].join('\n');
}

const upload = async (content: string, statementDate: string, bankFormat: string) => {
  const res = await callRoute(bulkCommit as never, tokens[a]!, f.c, 'POST', {
    bankAccountId: f.bank, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: 'stmt.csv', fileType: 'csv',
    statementDate, csvContent: content, bankFormat,
  }, '/api/accounting/bank-transactions-bulk-commit');
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return (res.state.body as { data: { batchId: string } }).data.batchId;
};

const agentImport = async (fileType: string, content: string, statementDate: string, bankFormat?: string) => {
  const res = await mcp(a, f.c, 'import_bank_statement', {
    bank_account_id: f.bank, file_type: fileType, content, statement_date: statementDate,
    ...(bankFormat ? { bank_format: bankFormat } : {}), idempotency_key: `wp1a-${crypto.randomUUID()}`,
  });
  expect(res.isError, res.content[0]!.text).toBeFalsy();
  return (JSON.parse(res.content[0]!.text) as { batch_id: string }).batch_id;
};

describe('statement balances on every import batch', () => {
  it('(a) upload, FNB CSV with a balance column, 1 of 4 lines already in: the WHOLE file\'s figures, running_balance', async () => {
    await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES($1,$2,DATE '2026-03-03',250.00,'A1 SALE','imported')`, [f.c, f.bank]);
    const id = await upload(fnbCsv('A', '03'), '2026-03-31', 'fnb');
    expect(await stored(id)).toEqual({ opening: '1000.00', closing: '1199.79', source: 'running_balance', lines: 3 });
  });

  it('(b) the same statement newest first gives the same figures', async () => {
    const id = await upload(fnbCsv('B', '04', { descending: true }), '2026-04-30', 'fnb');
    expect(await stored(id)).toEqual({ opening: '1000.00', closing: '1199.79', source: 'running_balance', lines: 4 });
  });

  it('(c) a generic CSV with no balance column: NULL figures, not_in_file', async () => {
    const csv = ['Date,Description,Amount', '2026-05-02,C ONE,-120.00', '2026-05-03,C TWO,450.00'].join('\n');
    const id = await upload(csv, '2026-05-31', 'generic');
    expect(await stored(id)).toEqual({ opening: null, closing: null, source: 'not_in_file', lines: 2 });
  });

  it('(d) an FNB CSV with one balance off by R1: NULL figures, unverified', async () => {
    const id = await upload(fnbCsv('D', '06', { breakBalance: true }), '2026-06-30', 'fnb');
    expect(await stored(id)).toEqual({ opening: null, closing: null, source: 'unverified', lines: 4 });
  });

  it('(e) agent import, MT940: the printed :60F: opening and :62F: closing, signed', async () => {
    const mt940 = [
      ':20:WP1A', ':25:STD/1234567890', ':60F:D260701ZAR1500,25',
      ':61:2607020702C2000,00NTRFE1//1', ':86:E ONE',
      ':61:2607030703D600,00NTRFE2//2', ':86:E TWO',
      ':62F:D260731ZAR100,25',
    ].join('\n');
    const id = await agentImport('mt940', mt940, '2026-07-31');
    expect(await stored(id)).toEqual({ opening: '-1500.25', closing: '-100.25', source: 'printed', lines: 2 });
  });

  it('(f) agent import, OFX: the printed ledger closing balance, NULL opening', async () => {
    const ofx = [
      'OFXHEADER:100', '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260802<TRNAMT>-120.00<FITID>F1<NAME>F ONE</STMTTRN>',
      '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260805<TRNAMT>450.00<FITID>F2<NAME>F TWO</STMTTRN>',
      '</BANKTRANLIST><LEDGERBAL><BALAMT>5330.00<DTASOF>20260831</LEDGERBAL>',
      '<AVAILBAL><BALAMT>9999.99<DTASOF>20260831</AVAILBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n');
    const id = await agentImport('ofx', ofx, '2026-08-31');
    expect(await stored(id)).toEqual({ opening: null, closing: '5330.00', source: 'printed', lines: 2 });
  });

  it('(g) OCR commit: the closing balance the read found is stored as ai_read (never printed); none found is not_in_file', async () => {
    const commitOcr = async (tag: string, opening: number | null, closing: number | null,
      period: [string | null, string | null] = ['2026-09-01', '2026-09-30'], date = '2026-09-07') => {
      const doc = (await pool.query(
        `INSERT INTO captured_documents(company_id, file_name, file_type, document_type, uploaded_by)
         VALUES($1,'stmt.pdf','pdf','statement',$2) RETURNING id`, [f.c, a])).rows[0].id as string;
      const rows = [{ date, description: `G ${tag}`, reference: null, amount: -55, runningBalance: null,
        isDuplicate: false, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 }];
      const imp = (await pool.query(
        `INSERT INTO bank_statement_imports(company_id, bank_account_id, source_document_id, period_start, period_end,
           opening_balance, closing_balance, row_count, extraction_summary, created_by)
         VALUES($1,$2,$3,$4::DATE,$5::DATE,$6,$7,1,$8::jsonb,$9) RETURNING id`,
        [f.c, f.bank, doc, period[0], period[1], opening, closing, JSON.stringify({ rows }), a])).rows[0].id as string;
      const res = await callRoute(ocrCommit as never, tokens[a]!, f.c, 'POST', undefined,
        `/api/accounting/bank-statements/${imp}/commit`, { id: imp });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
      return imp;
    };
    expect(await stored(await commitOcr('READ', 1055.5, 1000.5))).toEqual({ opening: '1055.50', closing: '1000.50', source: 'ai_read', lines: 1 });
    expect(await stored(await commitOcr('NONE', null, null))).toEqual({ opening: null, closing: null, source: 'not_in_file', lines: 1 });
    // Round 2 repros: each was stored as printed. Now none of them stores a figure.
    const doubted = { opening: null, closing: null, source: 'unverified', lines: 1 };
    expect(await stored(await commitOcr('AFTER END', null, 1000.5, ['2026-09-01', '2026-09-30'], '2026-10-15'))).toEqual(doubted);
    expect(await stored(await commitOcr('NO END', null, 1000.5, ['2026-09-01', null]))).toEqual(doubted);
    expect(await stored(await commitOcr('BACKWARDS', null, 1000.5, ['2026-09-30', '2026-09-01']))).toEqual(doubted);
    expect(await stored(await commitOcr('NOT ADDING UP', 1055.5, 1000))).toEqual(doubted);
  });

  it('(k) a generic CSV with a "Balance" header, statement dated its last line exactly: running_balance', async () => {
    const csv = ['Date,Description,Amount,Balance', '2026-12-01,K ONE,100.00,1100.00', '2026-12-02,K TWO,-40.00,1060.00'].join('\n');
    const id = await upload(csv, '2026-12-02', 'generic');
    expect(await stored(id)).toEqual({ opening: '1000.00', closing: '1060.00', source: 'running_balance', lines: 2 });
  });

  it('(l) round 2 repro: a generic CSV whose last row has a bad date imports the rest, and stores no figure', async () => {
    const csv = ['Date,Description,Amount,Balance', '2026-12-10,L ONE,100.00,1100.00', '2026-12-11,L TWO,100.00,1200.00',
      '31/31/2026,L THREE,100.00,1300.00'].join('\n');
    const id = await upload(csv, '2026-12-31', 'generic');
    expect(await stored(id)).toEqual({ opening: null, closing: null, source: 'unverified', lines: 2 });
  });

  it('(h) extension feed (ingestBankBatch): not_in_file', async () => {
    const conn = (await pool.query(
      `INSERT INTO bank_feed_connections(company_id,bank_account_id,provider,status,is_active,config)
       VALUES($1,$2,'test_provider','active',true,'{}') RETURNING id`, [f.c, f.bank])).rows[0].id as string;
    const out = await inRequest(pool, a, f.c, () => ingestBankBatch(f.c, {
      source: { kind: 'feed', connectionId: conn }, fetchedAt: '2026-10-11T08:00:00Z',
      transactions: [{ identity: { kind: 'provider', providerTransactionId: `wp1a-${conn}` }, state: 'posted',
        transactionDate: '2026-10-05', amount: -120, currency: 'ZAR', description: 'H FEED', providerUpdatedAt: '2026-10-05T10:00:00Z' }],
    } as never, { userId: a, sourceLabel: 'extension', bankFormat: null }));
    expect(await stored(out.importBatchId!)).toEqual({ opening: null, closing: null, source: 'not_in_file', lines: 1 });
  });

  it('(i) classified worksheet: not_in_file', async () => {
    const res = await callRoute(importClassified as never, tokens[a]!, f.c, 'POST', {
      bankAccountId: f.bank, transactions: [{ transactionDate: '2026-10-14', description: 'I CLASSIFIED', debit: 77 }],
    }, '/api/accounting/bank-transactions-import-classified');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const id = (res.state.body as { data: { batchId: string } }).data.batchId;
    expect(await stored(id)).toEqual({ opening: null, closing: null, source: 'not_in_file', lines: 1 });
  });

  it('(j) agent import whose statement date is before its last line: NULL figures, unverified', async () => {
    const id = await agentImport('csv', fnbCsv('J', '11'), '2026-11-05', 'fnb'); // lines run to 2026-11-06
    expect(await stored(id)).toEqual({ opening: null, closing: null, source: 'unverified', lines: 4 });
  });
});
