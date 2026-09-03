/**
 * MCP payroll tools — the four that make employment cost visible and postable.
 *
 * Payroll is the largest untouched statutory exposure in the books these tools
 * were specified against: Velocity Fibre and Brightsphere have zero pay runs
 * and zero payroll employees between them, no PAYE/UIF/SDL liability has ever
 * been raised, and the payroll GL structure sits empty (deactivated on
 * Brightsphere, active on Velocity). The load-bearing properties here are the
 * ones that decide whether an agent can be trusted with any of that:
 *
 *   - the dry run shows the FULL journal, including every employer
 *     contribution, because the finding is that only net pay ever posts;
 *   - the dry run runs EVERY guard the live path runs, so it cannot greenlight
 *     a call that would be refused;
 *   - a dry run sets `wroteNothing` so it does not burn the idempotency key;
 *   - SA identity numbers are masked unless explicitly asked for;
 *   - a deactivated target account is REPORTED, never filtered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/payroll/payrollEmployeeQueryService', () => ({
  listPayrollEmployeesPage: vi.fn(),
  payrollEmployeeCursorParts: (r: { lastName: string; firstName: string; id: string }) =>
    [r.lastName, r.firstName, r.id],
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunQueryService', () => ({
  listPayRunsPage: vi.fn(),
  payRunCursorParts: (r: { periodYear: number; periodMonth: number; id: string }) => [
    String(r.periodYear).padStart(6, '0'),
    String(r.periodMonth).padStart(2, '0'),
    r.id,
  ],
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({
  createPayrollRun: vi.fn(),
  getPayrollRun: vi.fn(),
  PayrollRunDuplicateError: class extends Error {},
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalBuilder', () => ({
  buildPayrollJournalPlan: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalPostingService', () => ({
  postPayrollRunJournal: vi.fn(),
}));

import { listPayrollEmployeesPage } from '@/modules/accounting/services/payroll/payrollEmployeeQueryService';
import { listPayRunsPage } from '@/modules/accounting/services/payroll/payrollRunQueryService';
import { createPayrollRun, getPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';

import { listEmployeesTool, listPayRunsTool } from '@/lib/mcp/tools/payroll';
import { createPayRunTool, postPayrollJournalTool } from '@/lib/mcp/tools/writePayroll';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { savepointNameFor } from '@/lib/mcp/registry';
import { PAT_SCOPES } from '@/lib/auth/patScopes';
import { OAUTH_SCOPES } from '@/lib/auth/oauthScopes';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const OTHER = '99999999-9999-9999-9999-999999999999';
const ME = '33333333-3333-3333-3333-333333333333';
const RUN = '44444444-4444-4444-4444-444444444444';
const KEY = { idempotency_key: 'k-1' };

const ctx: McpToolContext = {
  userId: ME,
  companyId: COMPANY,
  scopes: ['read:payroll', 'write:payroll', 'write:post'],
  tokenJti: 'j',
  oauthAppId: null,
};

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

const EMPLOYEE = {
  id: 'e1', employeeNumber: 'EMP001', firstName: 'Thandi', lastName: 'Mokoena',
  status: 'active', employmentType: 'permanent', startDate: '2024-03-01', endDate: null,
  costCentreId: null, uifExcluded: false,
  idNumber: '**********1234', taxNumber: '******7890', idNumberMasked: true,
};

const RUN_ROW = {
  id: RUN, companyId: COMPANY, periodMonth: 12, periodYear: 2026, status: 'approved',
  totalGross: 100000, totalPaye: 20000, totalUif: 2000, totalSdl: 1000, totalEti: 0,
  totalNet: 76000, employeeCount: 4, journalEntryId: null,
};

/** A plan with every statutory line, so a tool that dropped one is visible. */
const PLAN = {
  runId: RUN, status: 'approved', periodMonth: 12, periodYear: 2026, employeeCount: 4,
  alreadyPostedJournalId: null,
  entryDate: '2026-12-31',
  description: 'Payroll run 2026-12',
  reference: 'PAY-2026-12',
  lines: [
    { glAccountId: 'a5200', accountCode: '5200', accountName: 'Labour Costs', debit: 102000, credit: 0, description: 'Labour costs', inactiveAccount: false },
    { glAccountId: 'a2140', accountCode: '2140', accountName: 'PAYE Payable', debit: 0, credit: 20000, description: 'PAYE payable', inactiveAccount: false },
    { glAccountId: 'a2150', accountCode: '2150', accountName: 'UIF Payable', debit: 0, credit: 2000, description: 'UIF payable', inactiveAccount: false },
    { glAccountId: 'a2160', accountCode: '2160', accountName: 'SDL Payable', debit: 0, credit: 1000, description: 'SDL payable', inactiveAccount: false },
    { glAccountId: 'a1110', accountCode: '1110', accountName: 'Bank - Primary', debit: 0, credit: 76000, description: 'Net pay', inactiveAccount: false },
    { glAccountId: 'a2175', accountCode: '2175', accountName: 'Other Deductions', debit: 0, credit: 3000, description: 'Other deductions', inactiveAccount: false },
  ],
  totalDebit: 102000, totalCredit: 102000,
  totals: { gross: 100000, paye: 20000, uif: 2000, sdl: 1000, eti: 0, net: 76000, employerUif: 1000, otherDeductions: 3000 },
  blockers: [] as Array<{ code: string; detail: string }>,
  advisories: [] as Array<{ code: string; detail: string }>,
};

const plan = (over: Partial<typeof PLAN> = {}) => ({ ...PLAN, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPayrollEmployeesPage).mockResolvedValue({
    rows: [EMPLOYEE], rowsTotal: 1, universeTotal: 1,
    postedThrough: '2026-09-01T10:00:00.000Z', hasMore: false,
  });
  vi.mocked(listPayRunsPage).mockResolvedValue({
    rows: [RUN_ROW], rowsTotal: 1, universeTotal: 1,
    postedThrough: '2026-09-01T10:00:00.000Z', hasMore: false,
  });
  vi.mocked(getPayrollRun).mockResolvedValue(RUN_ROW);
  vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan());
  vi.mocked(postPayrollRunJournal).mockResolvedValue('je-new');
  vi.mocked(createPayrollRun).mockResolvedValue({ ...RUN_ROW, status: 'draft' });
});

// ───────────────────────────────────────────────────────────── registration ──

describe('registration', () => {
  const names = ['list_employees', 'list_pay_runs', 'create_pay_run', 'post_payroll_journal'];

  it('every payroll tool is registered and mirrored in the client list', () => {
    for (const n of names) {
      expect(MCP_TOOLS.map((t) => t.name)).toContain(n);
      expect(CLIENT_MCP_TOOL_NAMES).toContain(n);
    }
  });

  it('the payroll scopes exist in both vocabularies', () => {
    for (const s of ['read:payroll', 'write:payroll'] as const) {
      expect(PAT_SCOPES).toContain(s);
      expect(OAUTH_SCOPES).toContain(s);
    }
  });

  it('only post_payroll_journal requires write:post — creating a run posts nothing', () => {
    expect(postPayrollJournalTool.requiresPost).toBe(true);
    expect(createPayRunTool.requiresPost).toBeUndefined();
  });

  it('write tools survive savepoint-name truncation and stay distinct', () => {
    const saved = ['create_pay_run', 'post_payroll_journal'].map(savepointNameFor);
    for (const s of saved) expect(s.length).toBeLessThanOrEqual(31);
    expect(new Set(saved).size).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────── reads ──

describe('list_employees', () => {
  it('masks SA identity and tax numbers by default', async () => {
    const res = await listEmployeesTool.handler({}, ctx);
    expect(vi.mocked(listPayrollEmployeesPage).mock.calls[0]![1].revealIdentityNumbers).toBe(false);
    expect(json(res).rows[0].id_number).toBe('**********1234');
    expect(json(res).rows[0].id_number_masked).toBe(true);
  });

  it('reveals them only on an explicit request', async () => {
    await listEmployeesTool.handler({ reveal_identity_numbers: true }, ctx);
    expect(vi.mocked(listPayrollEmployeesPage).mock.calls[0]![1].revealIdentityNumbers).toBe(true);
  });

  it('lists EVERY status by default rather than only active employees', async () => {
    await listEmployeesTool.handler({}, ctx);
    expect(vi.mocked(listPayrollEmployeesPage).mock.calls[0]![1].status).toBeUndefined();
  });

  it('takes the company from the context, never from args', async () => {
    await listEmployeesTool.handler({ company_id: OTHER }, ctx);
    expect(vi.mocked(listPayrollEmployeesPage).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('returns a sound envelope with a checkable universe', async () => {
    const env = json(await listEmployeesTool.handler({}, ctx));
    expect(env.rowsReturned).toBe(1);
    expect(env.rowsTotal).toBe(1);
    expect(env.truncated).toBe(false);
    expect(env.excludedRows).toEqual([]);
    expect(env.posted_through).toBe('2026-09-01T10:00:00.000Z');
    expect(env.completenessFault).toBeUndefined();
  });

  it('emits a next_cursor only when more rows follow', async () => {
    expect(json(await listEmployeesTool.handler({}, ctx)).next_cursor).toBeNull();
    vi.mocked(listPayrollEmployeesPage).mockResolvedValue({
      rows: [EMPLOYEE], rowsTotal: 5, universeTotal: 5,
      postedThrough: '2026-09-01T10:00:00.000Z', hasMore: true,
    });
    expect(json(await listEmployeesTool.handler({}, ctx)).next_cursor).toBeTruthy();
  });

  it('refuses a malformed cursor instead of letting it reach a cast', async () => {
    const res = await listEmployeesTool.handler({ cursor: 'not-a-cursor' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('cursor');
  });
});

describe('list_pay_runs', () => {
  it('returns the statutory totals and whether the run reached the ledger', async () => {
    const env = json(await listPayRunsTool.handler({}, ctx));
    const row = env.rows[0];
    expect(row.total_paye).toBe(20000);
    expect(row.total_uif).toBe(2000);
    expect(row.total_sdl).toBe(1000);
    // The finding this endpoint exists for: a run can be approved and still
    // have posted nothing to the GL.
    expect(row.journal_entry_id).toBeNull();
    expect(row.posted_to_gl).toBe(false);
  });

  it('counts the whole company as the universe even when a status filter is applied', async () => {
    vi.mocked(listPayRunsPage).mockResolvedValue({
      rows: [RUN_ROW], rowsTotal: 1, universeTotal: 86,
      postedThrough: '2026-09-01T10:00:00.000Z', hasMore: false,
    });
    const env = json(await listPayRunsTool.handler({ status: 'approved' }, ctx));
    // 1 included + 0 excluded against a universe of 86 — the envelope must SAY
    // it cannot account for the other 85 rather than look complete.
    expect(env.completenessFault).toContain('85 unaccounted');
  });

  it('takes the company from the context, never from args', async () => {
    await listPayRunsTool.handler({ company_id: OTHER }, ctx);
    expect(vi.mocked(listPayRunsPage).mock.calls[0]![0]).toBe(COMPANY);
  });
});

// ────────────────────────────────────────────────────────────────── writes ──

describe('create_pay_run', () => {
  it('refuses an out-of-range month BEFORE calling the service', async () => {
    const res = await createPayRunTool.handler({ month: 13, year: 2026, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(createPayrollRun).not.toHaveBeenCalled();
  });

  it('dry run writes nothing, frees the key, and says what it would create', async () => {
    const res = await createPayRunTool.handler({ month: 12, year: 2026, dry_run: true, ...KEY }, ctx);
    expect(res.wroteNothing).toBe(true);
    expect(createPayrollRun).not.toHaveBeenCalled();
    expect(json(res).dryRun).toBe(true);
  });

  it('the dry run runs the duplicate guard the live path runs', async () => {
    // A dry run that passed where the real call refuses is worse than no dry
    // run. The duplicate is state, not request shape, so it is reported —
    // and the live path would refuse it.
    vi.mocked(listPayRunsPage).mockResolvedValue({
      rows: [{ ...RUN_ROW, periodMonth: 12, periodYear: 2026 }],
      rowsTotal: 1, universeTotal: 1, postedThrough: null, hasMore: false,
    });
    const res = await createPayRunTool.handler({ month: 12, year: 2026, dry_run: true, ...KEY }, ctx);
    expect(json(res).skipped.map((s: { reason: string }) => s.reason)).toContain('period_already_exists');
  });

  it('creates the run on a live call', async () => {
    const res = await createPayRunTool.handler({ month: 11, year: 2026, ...KEY }, ctx);
    expect(res.wroteNothing).toBeUndefined();
    expect(vi.mocked(createPayrollRun).mock.calls[0]![0]).toBe(COMPANY);
    expect(json(res).run_id).toBe(RUN);
  });
});

describe('post_payroll_journal — the dry run is the deliverable', () => {
  it('returns the FULL journal, not a count, and every employer contribution is in it', async () => {
    const res = await postPayrollJournalTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx);
    const out = json(res);
    const j = out.journals[0];
    const codes = j.lines.map((l: { accountCode: string }) => l.accountCode);

    expect(out.dryRun).toBe(true);
    expect(codes).toEqual(expect.arrayContaining(['5200', '2140', '2150', '2160', '1110', '2175']));
    expect(j.totalDebit).toBe(102000);
    expect(j.totalCredit).toBe(102000);
    // R102,000 of employment cost against R76,000 of net pay: the R26,000 gap
    // is the whole finding.
    expect(j.totalDebit - out.employment_cost.net_pay).toBe(26000);
  });

  it('sets wroteNothing on the dry run so the real call is not served the preview', async () => {
    const res = await postPayrollJournalTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx);
    expect(res.wroteNothing).toBe(true);
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });

  it('reports a deactivated target account rather than dropping the line', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan({
      lines: PLAN.lines.map((l) => (l.accountCode === '1110' ? { ...l, inactiveAccount: true } : l)),
      advisories: [{ code: 'inactive_target_account', detail: 'posts into deactivated accounts: 1110' }],
    }));
    const out = json(await postPayrollJournalTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx));
    expect(out.journals[0].lines.find((l: { accountCode: string }) => l.accountCode === '1110').credit).toBe(76000);
    expect(out.advisories[0].code).toBe('inactive_target_account');
  });

  it('the dry run refuses everything the live path would refuse', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan({
      blockers: [{ code: 'run_not_approved', detail: "This run is 'calculated'." }],
    }));
    const res = await postPayrollJournalTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('run_not_approved');
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });

  it('refuses a run in another company with the shared not-found text', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(null);
    const res = await postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    // A distinct "belongs to another company" reply is an existence oracle.
    expect(text(res)).toBe('Not found');
  });

  it('refuses a malformed run_id before it reaches a cast', async () => {
    const res = await postPayrollJournalTool.handler({ run_id: 'abc', ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(buildPayrollJournalPlan).not.toHaveBeenCalled();
  });

  it('stamps the posting as an agent so list_agent_postings can see it', async () => {
    await postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx);
    const call = vi.mocked(postPayrollRunJournal).mock.calls[0]!;
    expect(call[0]).toBe(COMPANY);
    expect(call[3]).toEqual({ postingAgent: 'mcp:post_payroll_journal:v1' });
  });

  it('RETHROWS a failure from the poster instead of returning toolError', async () => {
    // Once a service that can write has been called, a returned toolError
    // releases the savepoint and COMMITs the partial write, and frees the key
    // for a retry that writes again.
    vi.mocked(postPayrollRunJournal).mockRejectedValue(new Error('boom'));
    await expect(
      postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx),
    ).rejects.toThrow('boom');
  });
});
