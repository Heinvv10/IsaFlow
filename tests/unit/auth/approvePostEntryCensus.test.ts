/**
 * #1656, Hein 2026-11-19 ("gate everything"): every PERSON or TOKEN entry point that approves, posts or reverses asks
 * the module's Approve (User Access) before it writes. Two censuses pin it:
 *
 *  1. HTTP, TRANSITIVE (round 3: the old census matched direct calls by file, so a route that reached postJournalEntry
 *     through a helper, or gated one action of several, passed). tests/unit/helpers/approveCensusGraph.ts builds the
 *     call graph of the real program (type-checker resolved) from pages/api and src: a function that reaches a
 *     primitive (SINKS: postJournalEntry, reverseJournalEntry, the approve/cancel/void services ...) with a call no gate
 *     dominates is itself dangerous, and a route whose handler is dangerous fails. A gate (GATES) must sit on every
 *     path to the call inside the function (a preceding statement, an enclosing condition), or the route's default export
 *     is wrapped by withPayrollModule. A route is exempt only in EXEMPT_ROUTES, with the reason; a stale exemption fails.
 *  2. MCP: every tool that requires write:post, or whose name says it approves / posts / reverses, declares
 *     `approveModule` (the registry's module fence asks it before the handler), or is in EXEMPT_TOOLS with the reason.
 *
 * Out of scope, by ruling: system / cron runners (pages/api/cron/**, scheduled jobs, webhooks). They act for no
 * person, so there is no person's Approve to ask; their own gates (approval rules, unattended holds) still apply.
 * Each gate's placement is also pinned by the per-path tests (approveGateEverything, breaker1670*, the 403 tests per
 * route in routeApproveGates.test.ts, the integration suite migration-1010-roles-and-permissions).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { analyse } from '../helpers/approveCensusGraph';
import {
  GATES, PAYROLL_DETAIL_SQL, PAYROLL_READ_GATES, PAYROLL_READ_WRAPPERS, ROUTE_WRAPPERS, SINK_MODULES, SQL_PRIMITIVES,
} from '../helpers/approveCensusConfig';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';

/** MCP tools that require write:post or are named like a posting tool, yet post nothing. */
const EXEMPT_TOOLS: Readonly<Record<string, string>> = {
  apply_credit_note: 'posts no journal: the note\'s own journal posted at approval; only subledger balances move',
  unapply_credit_note: 'posts no journal: only subledger balances move',
  unapply_supplier_payment: 'posts no journal: only subledger balances move',
  adjust_credit_note_application: 'posts no journal: only subledger balances move',
  auto_apply_unapplied: 'posts no journal and creates no document: only subledger balances move',
  cancel_customer_invoice: 'drafts and pending-approval invoices only: no journal, nothing reverses',
  cancel_purchase_order: 'a purchase order has no journal',
  close_purchase_order: 'a purchase order has no journal',
  cancel_goods_received: 'a goods received note posts no journal: only purchase-order line quantities move (#1697)',
  link_bills_to_purchase_order: 'links documents; posts nothing',
  cancel_bank_reconciliation: 'discards an in-progress reconciliation; posts nothing',
  finalize_uploads: 'attaches uploaded files; posts nothing',
  lock_budget_version: 'locks a budget version; no ledger effect',
  submit_budget_for_review: 'submits for review; approving it is approve_budget_version (gated)',
  submit_time_entries: 'submits for review; approving them is the Accountant\'s Area approve (gated on the routes)',
  lock_vat_period: 'locks a VAT period; posts nothing',
  mark_vat_declared_elsewhere: 'records where a period was declared; posts nothing',
};

/** A tool name that says it approves, posts, finalises or reverses. */
const POSTING_NAME = /^(approve|bulk_approve|finali[sz]e|bulk_finali[sz]e|post|run|close|year_end|book|reverse|void|cancel|settle|reopen|allocate|bulk_allocate|reallocate|split_allocate|perform|merge|confirm|process|apply|unapply|adjust|link|tag|set_opening|dispose|write_off|auto_apply|submit|mark|lock)_/;

const apiFiles = execFileSync('git', ['ls-files', 'pages/api'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.ts$/.test(f) && !f.startsWith('pages/api/cron/') && !f.startsWith('pages/api/webhooks/'));

const programFiles = execFileSync('git', ['ls-files', 'pages', 'src'], { encoding: 'utf8' }).split('\n')
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
/**
 * The posting census's rules, shared by the real tree and the fixtures below. flagPrimitiveRoots + queryCalls (#1670 Codex): a
 * handler that posts in its OWN SQL (sql`` or client.query) calls no sink, and was not judged.
 */
const POSTING_RULES = {
  sinks: SINK_MODULES, gates: GATES, routeWrappers: ROUTE_WRAPPERS, sqlPrimitives: SQL_PRIMITIVES, flagPrimitiveRoots: true, queryCalls: true,
} as const;
let memo: ReturnType<typeof analyse> | undefined;
const census = () => (memo ??= analyse({ routeFiles: apiFiles, programFiles, ...POSTING_RULES }));

/** Routes outside pages/api/payroll that could return one person's pay (the employee portal authenticates the employee herself). */
const payrollReadRoutes = apiFiles.filter((f) => !f.startsWith('pages/api/payroll/') && !f.startsWith('pages/api/employee-portal/'));
let payrollMemo: ReturnType<typeof analyse> | undefined;
const payrollCensus = () => (payrollMemo ??= analyse({
  routeFiles: payrollReadRoutes, programFiles, sinks: {}, gates: PAYROLL_READ_GATES, routeWrappers: PAYROLL_READ_WRAPPERS,
  sqlPrimitives: PAYROLL_DETAIL_SQL, flagPrimitiveRoots: true, queryCalls: true,
}));

describe('approve / post entry-point census (#1656)', () => {
  it('finds the posting routes (the census is not empty)', () => {
    expect(census().dangerousRoutes.length).toBeGreaterThan(50);
  }, 180_000);

  it('every route that reaches a posting primitive asks the module Approve before it, on every action', () => {
    expect(census().bad.map((b) => `${b.file} [${b.unit}] -> ${b.sites.join(', ')}`),
      'Gate these with refuseWithoutApprove before the call (on every action branch), or mark the one call census-exempt(<callee>): reason').toEqual([]);
  }, 180_000);

  it('a route outside pages/api/payroll that reads per-employee pay asks Payroll READ (withPayrollDetailAccess / withPayrollModule / refuseWithoutPayrollRead)', () => {
    expect(payrollCensus().bad.map((b) => `${b.file} [${b.unit}] -> ${b.sites.join(', ')}`),
      'Gate these with refuseWithoutPayrollRead, or mark the aggregate read census-exempt(sql|<callee>): reason').toEqual([]);
    expect(payrollCensus().dangerousRoutes.length).toBeGreaterThan(3);
  }, 180_000);

  it('the payroll-read primitives cover every per-employee table (round 7), and entity_changes only when asked for the employee types', () => {
    const reads = (sql: string) => PAYROLL_DETAIL_SQL.some((re) => re.test(sql));
    for (const t of ['payslips', 'payroll_employees', 'payroll_bank_details', 'payroll_bank_file_items', 'tax_directive_payments', 'tax_directives',
      'payroll_loans', 'payroll_loan_payments', 'payroll_garnishee_orders', 'payroll_garnishee_deductions', 'payroll_external_payslips',
      'payroll_batch_lines', 'payroll_employee_history', 'payroll_employee_fringe_benefits', 'pay_packages', 'payslip_deliveries', 'practice_staff_cost_rates']) {
      expect(reads(`SELECT x FROM ${t} WHERE company_id = ?`), t).toBe(true);
      expect(reads(`SELECT x FROM a JOIN public.${t} b ON b.id = a.id`), `JOIN ${t}`).toBe(true);
    }
    // quoted and schema-qualified spellings (round 8)
    expect(reads('SELECT 1 FROM "public"."payslips" p')).toBe(true);
    expect(reads('SELECT 1 FROM public."payroll_bank_details"')).toBe(true);
    expect(reads("SELECT * FROM entity_changes WHERE entity_type = 'payroll_employee'")).toBe(true);
    expect(reads("SELECT * FROM entity_changes WHERE entity_type = 'supplier'")).toBe(false);
    expect(reads('SELECT 1 FROM payroll_company_settings')).toBe(false);
  });

  it('every census-exempt marker is still needed by one of the two censuses: its call would otherwise be uncovered (no stale pin)', () => {
    const payrollFiles = new Set(payrollReadRoutes);
    const stale = census().staleMarkers.filter((m) => !payrollFiles.has(m.split(':')[0]!) || payrollCensus().staleMarkers.includes(m));
    expect(stale).toEqual([]);
    expect(census().markersUsed.length + payrollCensus().markersUsed.length).toBeGreaterThanOrEqual(17);
  }, 180_000);

  it('#1670 Codex: an unguarded route that posts in its own SQL, sql`` or client.query, is a finding; a gate before it passes', () => {
    const fixture = (route: string) => {
      const files: Record<string, string> = {
        '/fx/lib.ts': `export declare function sql(s: TemplateStringsArray, ...v: unknown[]): Promise<unknown>;
export declare const client: { query: (text: string, values?: unknown[]) => Promise<unknown> };
export declare function refuseWithoutApprove(res: unknown, c: string, u: string, m: string, w: string): Promise<boolean>;
export async function flipBill(id: string) { await client.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [id]); }`,
        '/fx/route.ts': `import { sql, client, refuseWithoutApprove, flipBill } from './lib';\ndeclare const res: unknown;\n${route}\nexport default handler;`,
      };
      return analyse({ virtualFiles: files, programFiles: Object.keys(files), routeFiles: ['/fx/route.ts'], ...POSTING_RULES }).bad;
    };
    const gate = "if (await refuseWithoutApprove(res, 'c', 'u', 'accounts', 'journals')) return;";
    const tagged = "await sql`UPDATE gl_journal_entries SET status = 'posted' WHERE id = ${id}`;";
    const query = "await client.query(`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW() WHERE id = $1`, [id]);";
    expect(fixture(`async function handler(id: string) { ${tagged} }`)).toHaveLength(1);
    expect(fixture(`async function handler(id: string) { ${query} }`)).toHaveLength(1);
    expect(fixture("async function handler(id: string) { await flipBill(id); }")).toHaveLength(1); // a helper's client.query
    expect(fixture(`async function handler(id: string) { ${gate} ${tagged} ${query} await flipBill(id); }`)).toEqual([]);
  });

  it('#1670 Codex: withPayrollModule (Payroll read / write) is no proof of Payroll Approve in the posting census; it still is for payroll access', () => {
    const files: Record<string, string> = {
      '/fx/svc.ts': 'export async function approvePayrollRun(c: string, id: string) { return id; }',
      '/fx/route.ts': `import { approvePayrollRun } from './svc';\ndeclare function withPayrollModule<T>(h: T): T;
async function handler(id: string) { await approvePayrollRun('c', id); }\nexport default withPayrollModule(handler);`,
    };
    const bad = analyse({ virtualFiles: files, programFiles: Object.keys(files), routeFiles: ['/fx/route.ts'], ...POSTING_RULES }).bad;
    expect(bad.map((b) => b.sites.join())).toEqual([expect.stringContaining('approvePayrollRun[payroll]')]);
    expect(PAYROLL_READ_WRAPPERS.withPayrollModule).toBe('payroll');
  });

  it('every MCP tool that posts declares its approve module', () => {
    const posting = MCP_TOOLS.filter((t) => t.requiresPost || POSTING_NAME.test(t.name));
    expect(posting.length).toBeGreaterThan(40);
    const missing = posting.filter((t) => !t.approveModule && !EXEMPT_TOOLS[t.name]).map((t) => t.name);
    expect(missing, `Declare approveModule on these tools, or exempt them with a reason: ${missing.join(', ')}`).toEqual([]);
  });

  it('every exempt tool exists and still lacks a module (no stale pin)', () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    const stale = Object.keys(EXEMPT_TOOLS).filter((n) => !names.has(n)
      || MCP_TOOLS.find((t) => t.name === n)!.approveModule !== undefined);
    expect(stale).toEqual([]);
  });

  it('the lead\'s named tools are gated', () => {
    const named = ['post_journal', 'post_reclassification_batch', 'allocate_bank_transaction', 'perform_bank_reconciliation',
      'close_fiscal_period', 'year_end_close', 'run_depreciation', 'run_recurring_journals', 'book_eti_for_month'];
    const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
    expect(named.filter((n) => !byName.get(n)?.approveModule)).toEqual([]);
  });
});
