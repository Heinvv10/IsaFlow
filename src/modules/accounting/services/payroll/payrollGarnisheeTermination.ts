/**
 * Garnishee orders on an off-cycle TERMINATION line (wave 7 GT, W11; Hein rulings 6 and 15; grill F12). Pure: the
 * calculator calls applyGarnishees with `termination` for such a line, and this module holds its base, its pay ceiling
 * and its warnings.
 *
 * The rule:
 *  - Attachable base = the leave pay-out and notice pay on the line. On a termination line those are its only 3605
 *    earnings (payrollRunTermination builds the line from the termination pay-outs on no other pay; both are 3605 by
 *    PAYE-GEN-01-G21 (2027) Rev 1 p. 31-32). Severance (3901) and a retirement lump sum (39xx) are never attached
 *    (ruling 6).
 *  - Per order one instalment, min(instalment, balance), unless the month's other final run took it (takenThisMonth,
 *    set by the loader; ruling 15). Both ways (F12): a regular line skips an order the month's final termination run
 *    took, so a month never deducts an order twice.
 *  - Emoluments attachment orders together within 25% of the base; maintenance first and outside it; never above what
 *    the order still owes; never above the attachable pay left.
 *
 * The law this relies on (both Acts read 2026-11-26 in the Juta consolidations on justice.gov.za, legislation/acts
 * 1944-032.pdf and 1998-099.pdf):
 *  - Magistrates' Courts Act 32 of 1944 s61: "'emoluments' includes- (i) salary, wages or any other form of remuneration;
 *    and (ii) any allowances, whether expressed in money or not"; s65J(1)(b)(i): an emoluments attachment order "must
 *    attach the emoluments at present or in future owing or accruing to the judgment debtor by or from his or her
 *    employer". Leave pay and notice pay owed at termination are remuneration owing to the debtor, so they are
 *    emoluments the order attaches.
 *  - Maintenance Act 99 of 1998 s1: "'emoluments' includes any salary, wages, allowances or any other form of
 *    remuneration, whether expressed in money or not"; s28(1): an order "for the attachment of any emoluments at present
 *    or in future owing or accruing"; s29(3): the employer "shall give priority to the payments specified in that
 *    notice over any order of court requiring payments to be made from the emoluments".
 *  - On the leaver (the warning's last sentence): Maintenance Act s29(2): "Whenever any person to whom the notice relates
 *    leaves the service of the employer, that employer shall, within seven days after the day on which he or she so
 *    leaves the service, give notice thereof in the prescribed manner to the maintenance officer"; Magistrates' Courts
 *    Act s65J(8)(a): the judgment debtor who "leaves the service of a garnishee before the judgment debt has been paid in
 *    full ... must forthwith advise the judgment creditor" of the new employer (the debtor's duty, not the employer's).
 *
 * NAMED LIMITS (UNVERIFIED; the line's GARNISHEE_ON_TERMINATION warning says so):
 *  - The 25% is taken on leave + notice pay (ruling 15). s65J(1A)(b) defines basic salary as "the annual gross salary a
 *    judgment debtor is employed on divided by 12", which a termination line does not carry; the ruling's base can be
 *    lower or higher than the Act's.
 *  - Severance and retirement lump sums are left out on ruling 6, not on a statute read here: neither Act's text read
 *    excludes them (the Pension Funds Act s37A / s37D were not read).
 *  - The pay left for the orders is what the leave and notice pay net: net pay before the orders less what every other
 *    earning on the line nets (its cash amount less its own directive PAYE, PayeSplit.directive), floored at nil. The
 *    tables PAYE (3605 is taxed as an annual payment) and the UIF belong to the leave and notice pay, so a severance whose
 *    directive taxes it at nil keeps its whole amount (breaker #1939 H1: a pro-rata net x base / gross spread the leave
 *    pay's marginal tax over the severance and took up to R1 192 of severance).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode } from './payeAnnualPayment';
import type { EmployeeComponent, ValidationResult } from './payrollTypes';

export const GARNISHEE_ON_TERMINATION = 'GARNISHEE_ON_TERMINATION';
export const GARNISHEE_TAKEN_THIS_MONTH = 'GARNISHEE_TAKEN_THIS_MONTH';
/** Leave pay-out and notice pay on termination (payrollTerminationService: both 3605). Kept named for the mutation test. */
export const TERMINATION_ATTACHABLE_CODES: ReadonlySet<string> = new Set(['3605']);

const cents = (n: number): number => Math.round(n * 100);

/** The termination line's attachable pay: its leave pay-out and notice pay, net of any reversal, never below nil. */
export function terminationAttachableBaseOf(components: readonly EmployeeComponent[]): number {
  const total = components
    .filter((c) => c.component.componentType === 'earning' && TERMINATION_ATTACHABLE_CODES.has(normaliseSarsCode(c.component.sarsSourceCode)))
    .reduce((sum, c) => sum + cents(c.amount), 0);
  return Math.max(0, total) / 100;
}

/**
 * The pay the orders may take on a termination line, in cents: net pay before the orders less the other earnings' own
 * net (cash amount less the directive PAYE of the line's lump sums), never below nil; nil with no leave or notice pay.
 */
export function terminationPayLeftCents(
  baseCents: number, netPayBefore: number, components: readonly EmployeeComponent[], directivePaye: number,
): number {
  if (baseCents <= 0) return 0;
  const otherCash = components
    .filter((c) => c.component.componentType === 'earning' && c.isNonCash !== true
      && !TERMINATION_ATTACHABLE_CODES.has(normaliseSarsCode(c.component.sarsSourceCode)))
    .reduce((sum, c) => sum + cents(c.amount), 0);
  const otherNet = Math.max(0, otherCash - cents(directivePaye));
  return Math.max(0, Math.max(0, cents(netPayBefore)) - otherNet);
}

/** One per order the termination line considered: what it deducted, and what the order still owes after it. */
export function terminationOrderWarning(order: { reference: string; creditorName: string; balance: number | null }, takenCents: number): ValidationResult {
  const remainder = order.balance == null
    ? 'The order has no total debt: it runs on'
    : `${formatMoney(Math.max(0, cents(order.balance) - takenCents) / 100)} is still owed`;
  return {
    code: GARNISHEE_ON_TERMINATION, severity: 'warning',
    message: `Garnishee order ${order.reference} (${order.creditorName}): ${formatMoney(takenCents / 100)} deducted from the leave and notice pay `
      + `of this termination run (severance and retirement lump sums are never attached). ${remainder}. The employee is leaving: for a `
      + 'maintenance order, notify the maintenance officer within seven days (Maintenance Act s29(2)); under an emoluments attachment the '
      + 'employee must tell the creditor of a new employer (Magistrates\' Courts Act s65J(8)(a)). UNVERIFIED: the 25% is taken on leave and '
      + 'notice pay (ruling), not on the Act\'s basic salary.',
  };
}

/** An order the month's other final run took: skipped on this line, named (info) with its id for the approval check. */
export function takenThisMonthNotice(orders: ReadonlyArray<{ id: string; reference: string; creditorName: string }>, termination: boolean): ValidationResult[] {
  if (orders.length === 0) return [];
  const named = orders.map((o) => `${o.creditorName} (${o.reference})`).join(', ');
  return [{
    code: GARNISHEE_TAKEN_THIS_MONTH, severity: 'info', orders: orders.map((o) => o.id),
    message: `Garnishee order ${named}: this month's instalment was taken by the month's ${termination ? 'regular' : 'termination'} run, `
      + 'so this run does not take it again.',
  }];
}
