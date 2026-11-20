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
import { GATES, ROUTE_WRAPPERS, SINK_MODULES, SITE_EXEMPTIONS, SQL_PRIMITIVES } from '../helpers/approveCensusConfig';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';

/** Routes that call a posting service without a route-level gate, and why that is right. */
const EXEMPT_ROUTES: Readonly<Record<string, string>> = {
  'pages/api/admin/migration/sage-commit.ts':
    'the admin portal (withAdmin, a platform super_admin acting on a company they are not a member of): no company User Access applies; audited by logAdminAction',
  'pages/api/portal/payments/paystack/verify.ts':
    'the customer portal: a payer settling an invoice through Paystack, no company member acts; the receipt is idempotent on the gateway reference',
  'pages/api/accounting/recurring-transactions-execute.ts':
    'executeRecurring asks the runner\'s Approve per template type in the service (journal: Accounts, invoice: Customers, bill: Suppliers) and leaves the document a draft without it',
};

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

let memo: ReturnType<typeof analyse> | undefined;
const census = () => (memo ??= analyse({
  routeFiles: apiFiles, programFiles: execFileSync('git', ['ls-files', 'pages', 'src'], { encoding: 'utf8' }).split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')),
  sinks: SINK_MODULES, gates: GATES, routeWrappers: ROUTE_WRAPPERS, sqlPrimitives: SQL_PRIMITIVES, siteExemptions: SITE_EXEMPTIONS,
}));

describe('approve / post entry-point census (#1656)', () => {
  it('finds the posting routes (the census is not empty)', () => {
    expect(census().dangerousRoutes.length).toBeGreaterThan(50);
  }, 180_000);

  it('every route that reaches a posting primitive asks the module Approve before it, on every action', () => {
    const ungated = census().bad.filter((b) => !EXEMPT_ROUTES[b.file]);
    expect(ungated.map((b) => `${b.file} [${b.unit}] -> ${b.sites.join(', ')}`),
      'Gate these with refuseWithoutApprove before the call (on every action branch), or exempt them with a reason').toEqual([]);
  }, 180_000);

  it('every site exemption is still used (no stale pin)', () => {
    const used = new Set(census().exemptionsUsed);
    const stale = Object.entries(SITE_EXEMPTIONS).flatMap(([file, callees]) => Object.keys(callees).map((c) => `${file}::${c}`)).filter((k) => !used.has(k));
    expect(stale).toEqual([]);
  }, 180_000);

  it('every exempt route is still flagged without its exemption (no stale pin)', () => {
    const flagged = new Set(census().bad.map((b) => b.file));
    expect(Object.keys(EXEMPT_ROUTES).filter((f) => !flagged.has(f))).toEqual([]);
  }, 180_000);

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
