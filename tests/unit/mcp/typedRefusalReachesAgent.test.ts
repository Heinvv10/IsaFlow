/**
 * A typed refusal must reach the MCP caller WITH ITS REMEDY.
 *
 * `safeErrorText` used to decide "may I show this message?" by asking whether
 * the error carried a `code` at all. That was true while every service refusal
 * was a bare `Error` — and became wrong the moment the refusals were given
 * classes (`SupplierPaymentRefusal`, `BankAllocationRefusal`, `ReceiptRefusal`),
 * because each carries a NAMED code. Every one of them was then read as a
 * driver error and replaced by the tool's generic fallback: the agent was told
 * "Could not apply this payment." where it used to be told "Invoice INV-9 is
 * cancelled and cannot receive a payment.", and an agent with no remedy retries
 * the same call.
 *
 * So the shape of the code decides. Both directions are pinned here: a named
 * code is surfaced, and a pg SQLSTATE is still hidden behind the fallback —
 * tightening the first without keeping the second would leak schema names to a
 * tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentApplicationService', () => ({
  planSupplierPaymentApplication: vi.fn(),
  applySupplierPaymentPlan: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierBankPaymentService', () => ({
  validateBankSupplierPayment: vi.fn(),
  applyBankLineToSupplierInvoices: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/receiptApplicationService', () => ({
  planReceiptApplication: vi.fn(),
  applyReceiptPlan: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/receiptMatchConfirmService', () => ({
  validateBankReceiptApplication: vi.fn(),
  confirmReceiptMatch: vi.fn(),
}));

import { planSupplierPaymentApplication } from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import { validateBankSupplierPayment } from '@/modules/accounting/services/ap/supplierBankPaymentService';
import { planReceiptApplication } from '@/modules/accounting/services/ar/receiptApplicationService';
import { validateBankReceiptApplication } from '@/modules/accounting/services/ar/receiptMatchConfirmService';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import { BankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { safeErrorText, NOT_A_REFUSAL_CODES } from '@/lib/mcp/tools/toolHelpers';
import { applyPaymentToSupplierInvoiceTool } from '@/lib/mcp/tools/writeApplySupplierPayment';
import { applyReceiptToInvoiceTool } from '@/lib/mcp/tools/writeApplyReceipt';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const INV_A = '44444444-4444-4444-8444-444444444444';
const TX = '66666666-6666-4666-8666-666666666666';

const REMEDY = 'Invoice INV-9 is cancelled and cannot receive a payment.';
const FALLBACK = 'FALLBACK';

function ctx(): McpToolContext {
  return {
    userId: '99999999-9999-4999-8999-999999999999',
    companyId: COMPANY,
    scopes: ['write:invoices', 'write:post', 'read:invoices', 'read:bank-tx'],
    tokenJti: 'jti',
    oauthAppId: null,
  };
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

/** A pg error as the driver raises it: a five-character SQLSTATE and raw text. */
function pgError(code: string): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "uq_gl_je_company_entry_number"'),
    { code },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('safeErrorText', () => {
  it('surfaces every typed refusal this codebase raises', () => {
    expect(safeErrorText(new SupplierPaymentRefusal(REMEDY), FALLBACK)).toBe(REMEDY);
    expect(safeErrorText(new BankAllocationRefusal(REMEDY), FALLBACK)).toBe(REMEDY);
    expect(safeErrorText(new ReceiptRefusal(REMEDY), FALLBACK)).toBe(REMEDY);
  });

  it('still surfaces a code-less application error', () => {
    expect(safeErrorText(new Error(REMEDY), FALLBACK)).toBe(REMEDY);
  });

  it('surfaces a named lock-timeout code, whose remedy IS the retry', () => {
    const timeout = Object.assign(
      new Error('Payment X is being processed by another request — retry in a moment.'),
      { code: 'PAYMENT_LOCK_TIMEOUT' },
    );
    expect(safeErrorText(timeout, FALLBACK)).toMatch(/retry in a moment/);
  });

  // The other direction. A guard that only ever widened would leak schema.
  it('hides a pg SQLSTATE behind the fallback', () => {
    expect(safeErrorText(pgError('23505'), FALLBACK)).toBe(FALLBACK);
    expect(safeErrorText(pgError('42703'), FALLBACK)).toBe(FALLBACK);
    expect(safeErrorText(pgError('25P02'), FALLBACK)).toBe(FALLBACK);
    expect(safeErrorText(pgError('40P01'), FALLBACK)).toBe(FALLBACK);
  });

  it('hides a Node system error and a non-string code', () => {
    expect(safeErrorText(Object.assign(new Error('/etc/x'), { code: 'ENOENT' }), FALLBACK))
      .toBe(FALLBACK);
    expect(safeErrorText(Object.assign(new Error('x'), { code: 500 }), FALLBACK)).toBe(FALLBACK);
  });

  it('hides anything that is not an Error', () => {
    expect(safeErrorText('a string', FALLBACK)).toBe(FALLBACK);
    expect(safeErrorText(null, FALLBACK)).toBe(FALLBACK);
  });

  // The hole a SHAPE test left. Node's own error codes are SCREAMING_SNAKE by
  // construction, so "contains an underscore" admitted every one of them —
  // and each carries an internal message naming argument names, received
  // values or a path. So would any `code` an attacker could influence.
  // Identity, not shape, is what closes a disclosure boundary.
  it('hides Node and library error codes, which are SCREAMING_SNAKE too', () => {
    for (const code of [
      'ERR_INVALID_ARG_TYPE', 'ERR_OUT_OF_RANGE', 'ERR_ASSERTION',
      'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR', 'UND_ERR_SOCKET',
    ]) {
      expect(safeErrorText(Object.assign(new Error('internal detail'), { code }), FALLBACK))
        .toBe(FALLBACK);
    }
  });

  it('hides an attacker-shaped code that merely looks like one of ours', () => {
    expect(safeErrorText(
      Object.assign(new Error('secret'), { code: 'RECEIPT_REFUSED_' }), FALLBACK,
    )).toBe(FALLBACK);
    expect(safeErrorText(
      Object.assign(new Error('secret'), { code: 'TOTALLY_LEGITIMATE_REFUSAL' }), FALLBACK,
    )).toBe(FALLBACK);
  });
});

/**
 * A census, not an assertion about behaviour: the allowlist fails CLOSED, so a
 * refusal class added later without listing its code silently loses its wording
 * at the MCP boundary. This is the thing that tells the author to add it.
 */
describe('the safeErrorText allowlist covers every refusal class in the repo', () => {
  it('surfaces the message of every `readonly code` this codebase declares', async () => {
    const { execFileSync } = await import('node:child_process');
    // `--untracked`: plain `git grep` searches the INDEX, so a brand-new
    // refusal class in an unstaged file is invisible and the census passes
    // green on the author's machine and fails in CI after the checkout.
    const out = execFileSync(
      'git', ['grep', '-h', '--untracked', "readonly code = '", '--', 'src/'],
      { encoding: 'utf8' },
    );
    // Every code declared under `src/` must be a DECISION: surfaced because it
    // is a genuine refusal, or listed in NOT_A_REFUSAL_CODES because it is an
    // internal invariant marker whose message helps nobody. That split is the
    // one this docblock used to prescribe for the day a non-refusal appeared;
    // `CLAIM_OUTSIDE_TRANSACTION` is that day. Do NOT resolve a new red here by
    // adding the code to REFUSAL_CODES without reading its message first.
    const codes = [...out.matchAll(/readonly code = '([A-Z0-9_]+)'/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(14);
    for (const code of codes) {
      const shown = safeErrorText(Object.assign(new Error(REMEDY), { code }), FALLBACK);
      if (NOT_A_REFUSAL_CODES.has(code)) {
        expect(shown, `${code} is not a refusal and must stay behind the fallback`)
          .toBe(FALLBACK);
      } else {
        expect(
          shown,
          `${code} is declared in src/ but missing from REFUSAL_CODES in toolHelpers.ts`,
        ).toBe(REMEDY);
      }
    }
  });
});

describe('apply_payment_to_supplier_invoice — both refusing paths reach the agent', () => {
  const ALLOC = { allocations: [{ invoice_id: INV_A, amount: 600 }], idempotency_key: 'k1' };

  it('payment_id path: planSupplierPaymentApplication refusal keeps its remedy', async () => {
    vi.mocked(planSupplierPaymentApplication).mockRejectedValue(new SupplierPaymentRefusal(REMEDY));
    const r = await applyPaymentToSupplierInvoiceTool.handler(
      { ...ALLOC, payment_id: PAYMENT }, ctx(),
    );
    expect(errText(r)).toBe(REMEDY);
  });

  it('bank_transaction_id path: validateBankSupplierPayment refusal keeps its remedy', async () => {
    const refusal = new SupplierPaymentRefusal(
      `Bank transaction ${TX} is "allocated" and cannot be allocated. Reverse it first.`,
    );
    vi.mocked(validateBankSupplierPayment).mockRejectedValue(refusal);
    const r = await applyPaymentToSupplierInvoiceTool.handler(
      { ...ALLOC, bank_transaction_id: TX }, ctx(),
    );
    expect(errText(r)).toMatch(/cannot be allocated\. Reverse it first\./);
  });

  it('a driver error on the same call is NOT surfaced', async () => {
    vi.mocked(planSupplierPaymentApplication).mockRejectedValue(pgError('23505'));
    const r = await applyPaymentToSupplierInvoiceTool.handler(
      { ...ALLOC, payment_id: PAYMENT }, ctx(),
    );
    expect(errText(r)).toBe('Could not apply this payment.');
    expect(errText(r)).not.toMatch(/uq_gl_je_company_entry_number/);
  });
});

describe('apply_receipt_to_invoice — the AR mirror', () => {
  const ALLOC = { allocations: [{ invoice_id: INV_A, amount: 600 }], idempotency_key: 'k2' };

  it('payment_id path: a ReceiptRefusal keeps its remedy', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValue(
      new ReceiptRefusal('This receipt is still a draft — no journal has posted for it.'),
    );
    const r = await applyReceiptToInvoiceTool.handler({ ...ALLOC, payment_id: PAYMENT }, ctx());
    expect(errText(r)).toMatch(/still a draft/);
  });

  it('bank_transaction_id path: a ReceiptRefusal keeps its remedy', async () => {
    vi.mocked(validateBankReceiptApplication).mockRejectedValue(
      new ReceiptRefusal(`No fiscal period covers 2026-01-01, the date of this bank line.`),
    );
    const r = await applyReceiptToInvoiceTool.handler({ ...ALLOC, bank_transaction_id: TX }, ctx());
    expect(errText(r)).toMatch(/No fiscal period covers/);
  });

  it('a driver error on the same call is NOT surfaced', async () => {
    vi.mocked(validateBankReceiptApplication).mockRejectedValue(pgError('42703'));
    const r = await applyReceiptToInvoiceTool.handler({ ...ALLOC, bank_transaction_id: TX }, ctx());
    expect(errText(r)).toBe('Could not allocate this bank transaction.');
  });
});
