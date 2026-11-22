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
import { existsSync, readFileSync } from 'fs';
import { collapse, UNSCOPED_MARKER } from '../helpers/approveCensusProgram';
import { analyse } from '../helpers/approveCensusGraph';
import { INVOICE_UNPAYMENT_WRITERS, PAYROLL_DETAIL_SQL, PAYROLL_READ_GATES, PAYROLL_READ_WRAPPERS, POSTING_RULES } from '../helpers/approveCensusConfig';
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
  mark_vat_declared_elsewhere: 'records where a period was declared; posts nothing',
  restore_budget_version: 'restores budget cells an MCP amount write changed (a grid save); approving a version is approve_budget_version',
  undo_bank_import: 'deletes only still-imported (never allocated or posted) bank lines; posts and reverses nothing',
};

/** A tool name that says it approves, posts, finalises, reverses, sends, files, pays, undoes, restores or releases (r13 L4). */
const POSTING_NAME = /^(send|file|pay|undo|restore|release|approve|bulk_approve|finali[sz]e|bulk_finali[sz]e|post|run|close|year_end|book|reverse|void|cancel|settle|reopen|allocate|bulk_allocate|reallocate|split_allocate|perform|merge|confirm|process|apply|unapply|adjust|link|tag|set_opening|dispose|write_off|auto_apply|submit|mark|lock)_/;

const apiFiles = execFileSync('git', ['ls-files', 'pages/api'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.ts$/.test(f) && !f.startsWith('pages/api/cron/') && !f.startsWith('pages/api/webhooks/'));

const programFiles = execFileSync('git', ['ls-files', 'pages', 'src'], { encoding: 'utf8' }).split('\n')
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
/** The posting census's rules (approveCensusConfig POSTING_RULES), on the real tree here; on fixtures in approveCensusFixtures.test.ts. */
let memo: ReturnType<typeof analyse> | undefined;
const census = () => (memo ??= analyse({ routeFiles: apiFiles, programFiles, ...POSTING_RULES }));

/** Routes outside pages/api/payroll that could return one person's pay (the employee portal authenticates the employee herself). */
const payrollReadRoutes = apiFiles.filter((f) => !f.startsWith('pages/api/payroll/') && !f.startsWith('pages/api/employee-portal/'));
let payrollMemo: ReturnType<typeof analyse> | undefined;
const payrollCensus = () => (payrollMemo ??= analyse({
  routeFiles: payrollReadRoutes, programFiles, sinks: {}, gates: PAYROLL_READ_GATES, routeWrappers: PAYROLL_READ_WRAPPERS,
  sqlPrimitives: PAYROLL_DETAIL_SQL, flagPrimitiveRoots: true, queryCalls: true, markerScope: 'payroll-read',
}));


describe('approve / post entry-point census (#1656)', () => {
  it('finds the posting routes (the census is not empty)', () => {
    expect(census().dangerousRoutes.length).toBeGreaterThan(50);
  }, 180_000);

  it('every route that reaches a posting primitive asks the module Approve before it, on every action', () => {
    expect(census().bad.map((b) => `${b.file} [${b.unit}] -> ${b.sites.join(', ')}`),
      'Gate these with refuseWithoutApprove before the call (on every action branch), or mark the one call census-exempt(<callee>, posting): reason').toEqual([]);
  }, 180_000);

  it('a route outside pages/api/payroll that reads per-employee pay asks Payroll READ (withPayrollDetailAccess / withPayrollModule / refuseWithoutPayrollRead)', () => {
    expect(payrollCensus().bad.map((b) => `${b.file} [${b.unit}] -> ${b.sites.join(', ')}`),
      'Gate these with refuseWithoutPayrollRead, or mark the aggregate read census-exempt(sql|<callee>, payroll-read): reason').toEqual([]);
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

  it('#1670 r12 M1: every census-exempt marker names its census (posting or payroll-read); an unscoped one fails', () => {
    const files = execFileSync('git', ['ls-files', 'pages', 'src'], { encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f));
    const unscoped: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (!text.includes('census-exempt(')) continue; // the heap: the real program is in this worker too
      text.split('\n').forEach((line, i) => { if (UNSCOPED_MARKER.test(line)) unscoped.push(`${f}:${i + 1}`); });
    }
    expect(unscoped, 'write census-exempt(<callee>, posting|payroll-read): reason').toEqual([]);
    expect(UNSCOPED_MARKER.test('// census-exempt(x): why')).toBe(true);
    expect(UNSCOPED_MARKER.test('// census-exempt(x, payroll-read): why')).toBe(false);
  });

  it('every census-exempt marker is still needed by the census it names: its call would otherwise be uncovered (no stale pin)', () => {
    // r12 M1: each census judges only its own markers, so a marker is stale unless the census it NAMES needs it (it used to pass when
    // either census did). A payroll-read marker where that census does not run (pages/api/payroll, the employee portal) is stale too.
    const payrollFiles = new Set(payrollReadRoutes);
    const misplaced: string[] = [];
    for (const f of apiFiles.filter((x) => !payrollFiles.has(x))) {
      const text = readFileSync(f, 'utf8');
      if (!text.includes('payroll-read)')) continue;
      text.split('\n').forEach((line, i) => { if (/census-exempt\([A-Za-z0-9_-]+,\s*payroll-read\)/.test(line)) misplaced.push(`${f}:${i + 1}`); });
    }
    expect([...census().staleMarkers, ...payrollCensus().staleMarkers, ...misplaced]).toEqual([]);
    expect(census().markersUsed.length + payrollCensus().markersUsed.length).toBeGreaterThanOrEqual(17);
  }, 180_000);

  it('#1720: every pinned invoice un-payment writer is still in its file (a pin whose statement is gone fails as stale)', () => {
    const stale = INVOICE_UNPAYMENT_WRITERS.filter((pin) => {
      // the file's static SQL text as the census reads it: binds as ?, whitespace collapsed
      const text = existsSync(pin.file) ? collapse(readFileSync(pin.file, 'utf8').replace(/\$\{[^}]*\}/g, '?')) : '';
      return !text.includes(pin.snippet);
    }).map((pin) => `${pin.file}:${pin.line} ${pin.why}`);
    expect(stale).toEqual([]);
    expect(INVOICE_UNPAYMENT_WRITERS.length).toBe(4);
  });

  it('every MCP tool that posts declares its approve module', () => {
    const posting = MCP_TOOLS.filter((t) => t.requiresPost || POSTING_NAME.test(t.name));
    expect(posting.length).toBeGreaterThan(40);
    const missing = posting.filter((t) => !t.approveModule && !EXEMPT_TOOLS[t.name]).map((t) => t.name);
    expect(missing, `Declare approveModule on these tools, or exempt them with a reason: ${missing.join(', ')}`).toEqual([]);
  });

  it('every exempt tool exists and still lacks a module (no stale pin)', () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    // r13 L4: and is a posting tool by the census's own test (a scope or its name), else its exemption pins nothing.
    const stale = Object.keys(EXEMPT_TOOLS).filter((n) => !names.has(n)
      || MCP_TOOLS.find((t) => t.name === n)!.approveModule !== undefined
      || !(MCP_TOOLS.find((t) => t.name === n)!.requiresPost || POSTING_NAME.test(n)));
    expect(stale).toEqual([]);
  });

  it('the lead\'s named tools are gated', () => {
    const named = ['post_journal', 'post_reclassification_batch', 'allocate_bank_transaction', 'perform_bank_reconciliation',
      'close_fiscal_period', 'year_end_close', 'run_depreciation', 'run_recurring_journals', 'book_eti_for_month'];
    const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
    expect(named.filter((n) => !byName.get(n)?.approveModule)).toEqual([]);
  });
});
