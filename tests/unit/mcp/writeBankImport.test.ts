// RED phase — written before implementation.
/**
 * MCP write tools: import_bank_statement / undo_bank_import.
 *
 * These are the first agent-facing tools that create bank transactions.
 * They post nothing — the auto-post sweep is suppressed — so the agent's
 * postings all continue to arrive through allocate_bank_transaction, which
 * already stamps mcp:* and is reversible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankStatementImportService', () => ({
  bankGlAccountBelongsToCompany: vi.fn(),
  importStatementForAgent: vi.fn(),
  undoImportBatch: vi.fn(),
}));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn() }));

import {
  bankGlAccountBelongsToCompany,
  importStatementForAgent,
  undoImportBatch,
} from '@/modules/accounting/services/bank/bankStatementImportService';
import { checkRateLimit } from '@/lib/rateLimit';
import { importBankStatementTool, undoBankImportTool } from '@/lib/mcp/tools/writeBankImport';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;

const validArgs = {
  bank_account_id: 'acct-1',
  file_type: 'ofx',
  content: '<OFX>…</OFX>',
  statement_date: '2026-04-30',
  idempotency_key: 'k1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(true);
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(importStatementForAgent).mockResolvedValue({
    batchId: 'batch-1',
    imported: 2,
    duplicates: 0,
    parseErrors: [],
    dateRange: { from: '2026-04-15', to: '2026-04-16' },
    netTotal: 3765.44,
  } as never);
});

describe('import_bank_statement', () => {
  it('does not require write:post — importing must never post a journal', () => {
    expect(importBankStatementTool.scope).toBe('write:bank-tx');
    expect(importBankStatementTool.write).toBe(true);
    expect(importBankStatementTool.requiresPost).toBeFalsy();
    expect(importBankStatementTool.inputSchema.required).toContain('idempotency_key');
  });

  it('takes the tenant from ctx and ignores any company_id in the arguments', async () => {
    await importBankStatementTool.handler({ ...validArgs, company_id: 'attacker' }, ctx);

    expect(bankGlAccountBelongsToCompany).toHaveBeenCalledWith('company-1', 'acct-1');
    const call = vi.mocked(importStatementForAgent).mock.calls[0]![0];
    expect(call.companyId).toBe('company-1');
  });

  it("refuses another tenant's bank account with the same text as a genuine miss", async () => {
    vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(false);

    const res = await importBankStatementTool.handler(validArgs, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
    expect(importStatementForAgent).not.toHaveBeenCalled();
  });

  it('stamps the import so it is attributable to the agent', async () => {
    await importBankStatementTool.handler(validArgs, ctx);

    const call = vi.mocked(importStatementForAgent).mock.calls[0]![0];
    expect(call.importedBy).toBe('mcp:import_bank_statement:v1');
  });

  it('rejects an unsupported file_type rather than guessing a parser', async () => {
    const res = await importBankStatementTool.handler({ ...validArgs, file_type: 'xlsx' }, ctx);

    expect(res.isError).toBe(true);
    expect(importStatementForAgent).not.toHaveBeenCalled();
  });

  it('rejects pdf — base64 does not fit the transport and the agent sends OFX', async () => {
    const res = await importBankStatementTool.handler({ ...validArgs, file_type: 'pdf' }, ctx);

    expect(res.isError).toBe(true);
    expect(importStatementForAgent).not.toHaveBeenCalled();
  });

  it('rejects empty content without calling the service', async () => {
    const res = await importBankStatementTool.handler({ ...validArgs, content: '   ' }, ctx);

    expect(res.isError).toBe(true);
    expect(importStatementForAgent).not.toHaveBeenCalled();
  });

  it('requires a statement_date — the batch row cannot be written without one', async () => {
    const args = { ...validArgs } as Record<string, unknown>;
    delete args.statement_date;

    const res = await importBankStatementTool.handler(args, ctx);

    expect(res.isError).toBe(true);
    expect(importStatementForAgent).not.toHaveBeenCalled();
  });

  it('passes dry_run through so the agent can look before writing', async () => {
    vi.mocked(importStatementForAgent).mockResolvedValue({
      batchId: null, imported: 2, duplicates: 1, parseErrors: [],
      dateRange: { from: '2026-04-15', to: '2026-04-16' }, netTotal: 0,
    } as never);

    await importBankStatementTool.handler({ ...validArgs, dry_run: true }, ctx);

    expect(vi.mocked(importStatementForAgent).mock.calls[0]![0].dryRun).toBe(true);
  });

  it('bounds write pressure with a per-company rate limit', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    const res = await importBankStatementTool.handler(validArgs, ctx);

    expect(res.isError).toBe(true);
    expect(importStatementForAgent).not.toHaveBeenCalled();
  });

  it('reports duplicates and the batch id so the agent can verify and undo', async () => {
    const res = await importBankStatementTool.handler(validArgs, ctx);

    const payload = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(payload.batch_id).toBe('batch-1');
    expect(payload.imported).toBe(2);
    expect(payload.duplicates).toBe(0);
  });
});

describe('undo_bank_import', () => {
  it('is a write tool that posts nothing', () => {
    expect(undoBankImportTool.scope).toBe('write:bank-tx');
    expect(undoBankImportTool.write).toBe(true);
    expect(undoBankImportTool.requiresPost).toBeFalsy();
  });

  it('reports the rows it refused to delete, by status, rather than claiming a clean undo', async () => {
    vi.mocked(undoImportBatch).mockResolvedValue({
      deleted: 2, refused: 2, refusedByStatus: { allocated: 1, reconciled: 1 },
    } as never);

    const res = await undoBankImportTool.handler(
      { batch_id: 'batch-1', idempotency_key: 'k1' }, ctx,
    );

    const payload = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(payload.deleted).toBe(2);
    expect(payload.refused).toBe(2);
    expect(payload.refused_by_status).toEqual({ allocated: 1, reconciled: 1 });
  });

  it('rejects an unsupported bank_format rather than passing it to the parser', async () => {
    const res = await importBankStatementTool.handler(
      { ...validArgs, file_type: 'csv', bank_format: 'barclays' }, ctx,
    );

    expect(res.isError).toBe(true);
    expect(importStatementForAgent).not.toHaveBeenCalled();
  });

  it('bounds undo write pressure with its own rate limit', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    const res = await undoBankImportTool.handler(
      { batch_id: 'batch-1', idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
    expect(undoImportBatch).not.toHaveBeenCalled();
  });

  it("refuses another tenant's batch with the same text as a genuine miss", async () => {
    vi.mocked(undoImportBatch).mockResolvedValue(null as never);

    const res = await undoBankImportTool.handler(
      { batch_id: 'someone-elses', idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
  });

  it('rejects a missing batch_id without calling the service', async () => {
    const res = await undoBankImportTool.handler({ idempotency_key: 'k1' }, ctx);

    expect(res.isError).toBe(true);
    expect(undoImportBatch).not.toHaveBeenCalled();
  });
});
