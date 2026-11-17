/**
 * Garnishee orders on a pay line (wave 6 GA). Pure: the run service loads the orders (payrollGarnisheeRun) and the
 * calculator applies them to the net pay it has already costed. A garnishee is taken from net pay after tax: it is no
 * deduction for PAYE, UIF or SDL and no IRP5 code, so no statutory figure moves.
 *
 * The law this follows (both Acts read 2026-11-17 in the Juta consolidations on justice.gov.za):
 *  - Magistrates' Courts Act 32 of 1944 s65J(1A)(a), as substituted by s9 of Act 7 of 2017 (in force 1 August 2018):
 *    "The amount of the instalment payable or the total amount of instalments payable where there is more than one
 *    emoluments attachment order payable by the judgment debtor, may not exceed 25 per cent of the judgment debtor's
 *    basic salary." s65J(1A)(b): basic salary is "the annual gross salary ... divided by 12 and excludes additional
 *    remuneration for overtime or other allowances". (The wave-6 spec cites s65J(2)(b); in the consolidated text the
 *    limit is (1A)(a), and s65J(2) is the court's authorisation.)
 *  - Maintenance Act 99 of 1998 s28(1): a maintenance court's emoluments attachment states the payments, with no
 *    percentage limit; s29(3): the employer "shall give priority to the payments specified in that notice over any order
 *    of court requiring payments to be made from the emoluments". So maintenance is outside the 25 % and is taken first.
 *
 * NAMED LIMITS:
 *  - Basic salary is this line's 3601 earnings (periodic salary), not the contractual annual salary / 12: a starter's
 *    pro-rated month gives a lower limit than the Act's (conservative: the employee keeps more, never less).
 *  - An administration order (Magistrates' Courts Act s74) is taken in full, outside the 25 %: s74 was not read, so a
 *    line carrying one warns GARNISHEE_ADMINISTRATION_UNVERIFIED.
 *  - Within the limit and within net pay, orders are taken by kind (maintenance first, s29(3)), then by the order's
 *    priority (lower first), then oldest first: the court's own division (s65J(1A)(c)(iii)) is entered as instalments.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode } from './payeAnnualPayment';
import type { EmployeeComponent, ValidationResult } from './payrollTypes';

export const GARNISHEE_KINDS = ['emolument_attachment', 'maintenance', 'administration'] as const;
export type GarnisheeKind = (typeof GARNISHEE_KINDS)[number];

/** An order the run may deduct from, as payrollGarnisheeRun loads it (active for the period, balance not yet nil). */
export interface GarnisheeOrderInput {
  id: string;
  kind: GarnisheeKind;
  reference: string;
  creditorName: string;
  /** The instalment the order states for a month. */
  instalment: number;
  /** What is still owed, or null for an order with no total (an ongoing maintenance order). */
  balance: number | null;
  priority: number;
  /** For the oldest-first tie-break: ISO timestamp. */
  createdAt: string;
}

export interface GarnisheeDeduction {
  orderId: string;
  kind: GarnisheeKind;
  reference: string;
  creditorName: string;
  /** min(instalment, balance): what the order asked of this line. */
  requested: number;
  /** What the line deducts: never above `requested`, the 25 % limit (attachments) or the net pay left. */
  amount: number;
}

/** A garnishee-order write refused before any write: the route answers it with its status and `details.reason`. */
export class GarnisheeOrderRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly reason: string, message: string) {
    super(message);
    this.name = 'GarnisheeOrderRefusal';
  }
}

/** s65J(1A)(a). Kept as a named constant so a mutation test can switch the limit off. */
export const EMOLUMENT_ATTACHMENT_SHARE = 0.25;
const BASIC_SALARY_CODE = '3601';

const cents = (n: number): number => Math.round(n * 100);
const KIND_ORDER: Record<GarnisheeKind, number> = { maintenance: 0, emolument_attachment: 1, administration: 2 };

/** The line's basic salary for s65J(1A)(b): its 3601 earnings, net of any reversal, never below nil. */
export function basicSalaryOf(components: readonly EmployeeComponent[]): number {
  const total = components
    .filter((c) => c.component.componentType === 'earning' && normaliseSarsCode(c.component.sarsSourceCode) === BASIC_SALARY_CODE)
    .reduce((sum, c) => sum + cents(c.amount), 0);
  return Math.max(0, total) / 100;
}

export function orderGarnishees(orders: readonly GarnisheeOrderInput[]): GarnisheeOrderInput[] {
  return [...orders].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.priority - b.priority
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * The deductions a line takes for its orders, given the net pay before them (floored at nil here). Every figure is in
 * whole cents. Orders with nothing to take (a nil balance) are left out; an order cut by the limit or by net pay keeps
 * its row with the smaller amount (or none at all when nothing was left) and a warning names it.
 */
export function applyGarnishees(input: {
  orders: readonly GarnisheeOrderInput[];
  components: readonly EmployeeComponent[];
  netPayBefore: number;
}): { deductions: GarnisheeDeduction[]; total: number; warnings: ValidationResult[] } {
  const warnings: ValidationResult[] = [];
  const deductions: GarnisheeDeduction[] = [];
  let capLeft = Math.floor(cents(basicSalaryOf(input.components)) * EMOLUMENT_ATTACHMENT_SHARE);
  let netLeft = Math.max(0, cents(input.netPayBefore));
  for (const order of orderGarnishees(input.orders)) {
    const requested = Math.max(0, Math.min(cents(order.instalment), order.balance == null ? Infinity : cents(order.balance)));
    if (requested === 0) continue;
    let take = requested;
    if (order.kind === 'emolument_attachment') {
      take = Math.min(take, capLeft);
      capLeft -= take;
      if (take < requested) {
        warnings.push({
          code: 'GARNISHEE_LIMIT_APPLIED', severity: 'warning',
          message: `Garnishee order ${order.reference} (${order.creditorName}) asks ${formatMoney(requested / 100)}, but emoluments `
            + 'attachment orders together may not exceed 25% of basic salary (Magistrates\' Courts Act s65J(1A)(a)), so '
            + `${formatMoney(take / 100)} is deducted. The rest stays owed.`,
        });
      }
    }
    const capped = take;
    take = Math.min(take, netLeft);
    netLeft -= take;
    if (take < capped) {
      warnings.push({
        code: 'GARNISHEE_SHORTFALL', severity: 'warning',
        message: `Net pay cannot cover garnishee order ${order.reference} (${order.creditorName}): ${formatMoney(take / 100)} of `
          + `${formatMoney(capped / 100)} is deducted, so net pay is nil. The shortfall stays owed; tell the creditor.`,
      });
    }
    if (order.kind === 'administration') {
      warnings.push({
        code: 'GARNISHEE_ADMINISTRATION_UNVERIFIED', severity: 'warning',
        message: `Administration order ${order.reference} is deducted in full, outside the 25% limit for emoluments attachment `
          + 'orders. IsaFlow has not checked this against the Magistrates\' Courts Act s74: confirm the amount against the order.',
      });
    }
    deductions.push({
      orderId: order.id, kind: order.kind, reference: order.reference, creditorName: order.creditorName,
      requested: requested / 100, amount: take / 100,
    });
  }
  return { deductions, total: deductions.reduce((s, d) => s + cents(d.amount), 0) / 100, warnings };
}
