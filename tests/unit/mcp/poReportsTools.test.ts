/**
 * The PO report tools (docs/design/mcp-po-reports.md, tests 5 and 6) without a database:
 *   - the page bound: at the default and the maximum page, with every text at its widest, every date, amount and count at its widest and
 *     ten bills a PO, the reply stays under MAX_READ_RESULT_BYTES; a limit past the maximum is clamped;
 *   - registry and census: both tools are registered, in the client list, free, read-only, on the scope the design names, refused without
 *     that scope before their handler runs, and listed in the manifest a client's tools/list returns.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(async (..._a: unknown[]) => [] as unknown[]), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/mcp/audit', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/audit')>()),
  recordToolCall: vi.fn(async () => undefined), acquireIdempotencyLock: vi.fn(async () => undefined), findIdempotentReplay: vi.fn(async () => ({ status: 'none' as const })),
}));
vi.mock('@/lib/mcp/flowMetering', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/flowMetering')>()),
  debitForTool: vi.fn(async () => ({ ok: true as const, handle: null })), refundForTool: vi.fn(async () => undefined),
}));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getCompany: vi.fn(async () => ({ name: 'Acme' })) }));
vi.mock('@/modules/accounting/services/practice/practiceUsersService', () => ({ getCompanyUser: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/ap/poStatusReport', async (orig) => ({ ...(await orig<object>()), readPoStatusReport: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/committedSpend', async (orig) => { const real = await orig<typeof import('@/modules/accounting/services/budgets/committedSpend')>(); return { ...real, committedSpendReport: vi.fn(real.committedSpendReport) }; });
vi.mock('@/modules/accounting/services/budgets/remainingCommitted', async (orig) => ({ ...(await orig<object>()), readCommitmentLines: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', async (orig) => ({ ...(await orig<object>()), loadChartRefs: vi.fn(async () => ({ accounts: [], members: [] })) }));

import { sql } from '@/lib/neon';
import { checkRateLimit } from '@/lib/rateLimit';
import { committedSpendReport } from '@/modules/accounting/services/budgets/committedSpend';
import { McpRegistry } from '@/lib/mcp/registry';
import { MCP_TOOLS, mcpRegistry } from '@/lib/mcp/toolIndex';
import { MAX_READ_RESULT_BYTES } from '@/lib/mcp/resultSize';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import { COMMITTED_LIMIT_DEFAULT, COMMITTED_LIMIT_MAX, committedSpendTool } from '@/lib/mcp/tools/committedSpendTool';
import { PO_REPORT_LIMIT_DEFAULT, PO_REPORT_LIMIT_MAX } from '@/lib/mcp/tools/poStatusReportView';
import { poStatusReportTool } from '@/lib/mcp/tools/poStatusReportTool';
import { BILLS_SHOWN, readPoStatusReport, type PoStatusBill, type PoStatusRow } from '@/modules/accounting/services/ap/poStatusReport';
import { readCommitmentLines, type CommitmentLine } from '@/modules/accounting/services/budgets/remainingCommitted';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx = (scopes: string[], companyRole = 'owner'): McpToolContext => ({ userId: 'u-1', companyId: '22222222-2222-2222-2222-222222222222', tokenJti: 'j', oauthAppId: null, companyRole, scopes });
const bytes = (r: { content: Array<{ text: string }> }) => Buffer.byteLength(r.content[0]!.text, 'utf8');
const uuid = (i: number, tag: string) => `${tag}${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`;
const LONG = 'N'.repeat(400);

beforeEach(() => vi.clearAllMocks());

describe('po_status_report page bound', () => {
  const bill = (i: number): PoStatusBill => ({ billId: uuid(i, 'b'), number: LONG, status: 'partially_paid', via: 'header', attributedCents: 999_999_999_999_999, date: '2026-12-31', countsAsBilled: true });
  const row = (i: number): PoStatusRow => ({
    id: uuid(i, 'p'), poNumber: LONG, supplierId: uuid(i, 's'), supplierName: LONG, status: 'partially_received', closedFromStatus: 'partially_received', closedByBilling: true,
    orderDate: '2026-12-31', ageDays: 36500, orderedCents: 999_999_999_999_999, receivedCents: 999_999_999_999_999, billedCents: 999_999_999_999_999, outstandingCents: 999_999_999_999_999,
    committedCents: 999_999_999_999_999, lastReceiptDate: '2026-12-31', daysSinceLastReceipt: 36500, lastBillDate: '2026-12-31', daysSinceLastBill: 36500,
    bills: Array.from({ length: BILLS_SHOWN }, (_, b) => bill(i * 100 + b)), billsTotal: 9999,
  });
  const page = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => row(i)), total: 9_999_999, nextOffset: 9_999_999, asOf: '2026-12-31' });

  it.each([['default', undefined, PO_REPORT_LIMIT_DEFAULT], ['maximum', PO_REPORT_LIMIT_MAX, PO_REPORT_LIMIT_MAX], ['past the maximum', 99_999, PO_REPORT_LIMIT_MAX]])(
    '%s page: under MAX_READ_RESULT_BYTES with the widest content', async (_n, limit, rows) => {
      vi.mocked(readPoStatusReport).mockImplementation(async (_c, q) => page(q.limit));
      const r = await poStatusReportTool.handler(limit === undefined ? {} : { limit }, ctx(['read:invoices']));
      expect(r.isError).toBeUndefined();
      expect(vi.mocked(readPoStatusReport).mock.calls[0]![1].limit).toBe(rows);
      expect((JSON.parse(r.content[0]!.text) as { items: unknown[] }).items).toHaveLength(rows);
      expect(bytes(r), `${bytes(r)} bytes`).toBeLessThan(MAX_READ_RESULT_BYTES);
    });

  it('the widest page at the maximum is within a factor of two of the limit: the bound is real, not slack', async () => {
    vi.mocked(readPoStatusReport).mockResolvedValue(page(PO_REPORT_LIMIT_MAX));
    const full = bytes(await poStatusReportTool.handler({ limit: PO_REPORT_LIMIT_MAX }, ctx(['read:invoices'])));
    expect(full).toBeGreaterThan(MAX_READ_RESULT_BYTES * 0.5);
    expect(full * 2).toBeGreaterThan(MAX_READ_RESULT_BYTES);
  });
});

describe('committed_spend page bound', () => {
  const lines = (n: number): CommitmentLine[] => Array.from({ length: n }, (_, i) => ({
    poItemId: uuid(i, 'i'), glAccountId: uuid(i, 'a'), month: `20${String(30 + (i % 60)).padStart(2, '0')}-12`, cc1Id: uuid(i, 'c'), cc2Id: uuid(i, 'd'), buId: uuid(i, 'u'),
    lineTotal: 99_999_999_999.99, billed: [], poId: uuid(i, 'p'), supplierId: uuid(i, 's'),
  }));
  const named = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    const ids = (values.find((v) => Array.isArray(v)) as string[] | undefined) ?? [];
    if (!/FROM (suppliers|gl_accounts|cost_centres|business_units)/.test(q)) return [];
    return ids.map((id) => ({ id, code: LONG, name: LONG }));
  };

  it.each([['default', undefined, COMMITTED_LIMIT_DEFAULT], ['maximum', COMMITTED_LIMIT_MAX, COMMITTED_LIMIT_MAX], ['past the maximum', 99_999, COMMITTED_LIMIT_MAX]])(
    '%s page, six group keys: under MAX_READ_RESULT_BYTES with 400-character names and codes', async (_n, limit, rows) => {
      vi.mocked(readCommitmentLines).mockResolvedValue(lines(200));
      vi.mocked(sql).mockImplementation(named as never);
      const r = await committedSpendTool.handler({ from_month: '2026-01', to_month: '2026-12', group_by: ['supplier', 'cc2', 'account', 'cc1', 'bu', 'month'], ...(limit === undefined ? {} : { limit }) }, ctx(['read:reports']));
      expect(r.isError, r.content[0]!.text).toBeUndefined();
      const out = JSON.parse(r.content[0]!.text) as { rows: Array<{ account: { name: string; code: string } }>; next_offset: number | null; groups_total: number };
      expect(out.rows).toHaveLength(rows);
      expect(out.groups_total).toBe(200);
      expect(out.next_offset).toBe(rows);
      expect(out.rows[0]!.account.name.length).toBeLessThanOrEqual(60);
      expect(bytes(r), 'bytes').toBeLessThan(MAX_READ_RESULT_BYTES);
    });
});

describe('registry and census', () => {
  const NAMES = ['committed_spend', 'po_status_report'];
  it('both are registered once, free, read-only, on the design\'s scopes, with no role fence beyond the handler\'s', () => {
    for (const [name, scope] of [['committed_spend', 'read:reports'], ['po_status_report', 'read:invoices']] as const) {
      const t = MCP_TOOLS.filter((x) => x.name === name);
      expect(t, name).toHaveLength(1);
      expect(t[0]).toMatchObject({ scope, write: false });
      expect(t[0]!.requiresRole).toBeUndefined();
      expect(t[0]!.requiresPost).toBeUndefined();
      expect(t[0]!.requiresScope).toBeUndefined();
      expect(flowOperationFor(name, {}), name).toBeNull();
      expect(CLIENT_MCP_TOOL_NAMES).toContain(name);
    }
  });

  it('the manifest a client lists carries both, with their scopes named in the description or schema', () => {
    const listed = mcpRegistry.getManifest().filter((t) => NAMES.includes(t.name));
    expect(listed.map((t) => t.name).sort()).toEqual(NAMES);
    expect(listed.find((t) => t.name === 'committed_spend')!.description).toMatch(/Needs read:reports/);
    expect(listed.find((t) => t.name === 'po_status_report')!.description).toMatch(/Needs read:invoices/);
  });

  it.each([['committed_spend', 'read:invoices', { from_month: '2026-06', to_month: '2026-06' }], ['po_status_report', 'read:reports', {}]] as const)(
    '%s without its scope is refused before its handler runs', async (name, other, args) => {
      const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{}' }] }));
      const registry = new McpRegistry();
      registry.register({ ...MCP_TOOLS.find((t) => t.name === name)!, handler });
      const r = await registry.call(name, args, ctx([other]));
      expect(r.isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });

  it('no new scope: every scope the two tools need is one an existing tool already needs', () => {
    const used = new Set(MCP_TOOLS.filter((t) => !NAMES.includes(t.name)).map((t) => t.scope));
    for (const n of NAMES) expect(used.has(MCP_TOOLS.find((t) => t.name === n)!.scope)).toBe(true);
  });
});

describe('committed_spend rate limit (the bucket budget_remaining uses)', () => {
  const args = { from_month: '2026-06', to_month: '2026-06', group_by: [] };

  it('a user past the limit is refused before any read, with the budget previews wording', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);
    const r = await committedSpendTool.handler(args, ctx(['read:reports']));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Too many budget previews/);
    expect(checkRateLimit).toHaveBeenCalledWith('mcp-budget-remaining:u-1', { max: 120, windowSecs: 60 });
    expect(committedSpendReport).not.toHaveBeenCalled();
    expect(readCommitmentLines).not.toHaveBeenCalled();
  });

  it('within the limit it reads', async () => {
    vi.mocked(readCommitmentLines).mockResolvedValue([]);
    const r = await committedSpendTool.handler(args, ctx(['read:reports']));
    expect(r.isError).toBeUndefined();
    expect(committedSpendReport).toHaveBeenCalledTimes(1);
  });

  it('a refused request (bad window, viewer) does not spend a place in the bucket', async () => {
    await committedSpendTool.handler({ from_month: '2026-07', to_month: '2026-06' }, ctx(['read:reports']));
    await committedSpendTool.handler(args, ctx(['read:reports'], 'viewer'));
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('token_info lists the tools each granted scope opens', () => {
  const info = async (scopes: string[]) => JSON.parse((await MCP_TOOLS.find((t) => t.name === 'token_info')!.handler({}, ctx(scopes))).content[0]!.text) as
    { tools: Record<string, string[]>; tools_without_scope: string[]; scopes: string[] };

  it('read:reports lists committed_spend and not po_status_report; read:invoices the reverse', async () => {
    const reports = await info(['read:reports']);
    expect(Object.keys(reports.tools)).toEqual(['read:reports']);
    expect(reports.tools['read:reports']).toEqual(expect.arrayContaining(['committed_spend', 'budget_remaining']));
    expect(reports.tools['read:reports']).not.toContain('po_status_report');
    const invoices = await info(['read:invoices']);
    expect(Object.keys(invoices.tools)).toEqual(['read:invoices']);
    expect(invoices.tools['read:invoices']).toEqual(expect.arrayContaining(['po_status_report', 'get_purchase_order']));
    expect(invoices.tools['read:invoices']).not.toContain('committed_spend');
  });

  it('a scope no tool needs opens an empty list; scope-less tools are listed apart, whatever the grant', async () => {
    const none = await info(['read:nothing-uses-this']);
    expect(none.tools).toEqual({ 'read:nothing-uses-this': [] });
    expect(none.tools_without_scope).toEqual(expect.arrayContaining(['token_info']));
    expect(none.tools_without_scope).toEqual(MCP_TOOLS.filter((t) => t.scope === null).map((t) => t.name).sort());
  });

  it('census: with every scope granted, every registered tool appears exactly once, under its own scope', async () => {
    const all = [...new Set(MCP_TOOLS.map((t) => t.scope).filter((s): s is string => s !== null))];
    const out = await info(all);
    const seen = new Map<string, string>();
    for (const [scope, names] of Object.entries(out.tools)) {
      expect(names).toEqual([...names].sort());
      for (const n of names) {
        expect(seen.has(n), `${n} listed twice`).toBe(false);
        seen.set(n, scope);
      }
    }
    for (const n of out.tools_without_scope) seen.set(n, '(none)');
    for (const t of MCP_TOOLS) expect(seen.get(t.name), t.name).toBe(t.scope ?? '(none)');
    expect(seen.size).toBe(MCP_TOOLS.length);
  });

  it('the full listing is a small read: well under MAX_READ_RESULT_BYTES', async () => {
    const all = [...new Set(MCP_TOOLS.map((t) => t.scope).filter((s): s is string => s !== null))];
    const r = await MCP_TOOLS.find((t) => t.name === 'token_info')!.handler({}, ctx(all));
    expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES / 3);
  });
});
