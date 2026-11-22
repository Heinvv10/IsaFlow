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
vi.mock('@/modules/accounting/services/ap/poStatusReport', async (orig) => ({ ...(await orig<object>()), readPoStatusReport: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/remainingCommitted', async (orig) => ({ ...(await orig<object>()), readCommitmentLines: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', async (orig) => ({ ...(await orig<object>()), loadChartRefs: vi.fn(async () => ({ accounts: [], members: [] })) }));

import { sql } from '@/lib/neon';
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
  const bill = (i: number): PoStatusBill => ({ billId: uuid(i, 'b'), number: LONG, status: 'partially_paid', via: 'header', attributedCents: 999_999_999_999_999, date: '2026-12-31', countsAsBilled: true, deleted: true });
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
