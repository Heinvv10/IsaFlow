/**
 * UF (wave 6, Hein's ruling on #1482): a clawback is netted against this month's UIF pay, and the line says so.
 *
 * UIF is a monthly contribution: UIC Act 4 of 2002 s5(1) ("must, on a monthly basis, contribute") with s6(1) (1% of the
 * remuneration paid or payable "during any month"). Nothing carries a negative month forward, so a clawback larger
 * than the month's UIF pay gives nil (uifEngine.uifWithLeviable). Where the clawed-back pay was declared in an earlier
 * month, that month's contribution may have been too high: an excess paid is refunded to the employer (s8(3); s9(4)
 * for an employer paying the UIF Commissioner), and the employer must refund the employee's share deducted (s7(5)).
 * The engine cannot know the earlier month, so it warns.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { EarningPart } from './payrollLineAccumulate';
import type { ValidationResult } from './payrollTypes';

export const UIF_CLAWBACK = 'UIF_CLAWBACK';

/** A warning when a UIF-applicable earning below nil (a clawback) reduced the line's UIF pay, or took it below nil. */
export function uifClawbackWarnings(parts: EarningPart[], uifRemuneration: number): ValidationResult[] {
  const clawback = parts.filter((p) => p.uif && p.included < 0).reduce((s, p) => s - p.included, 0);
  if (clawback <= 0 && uifRemuneration >= 0) return [];
  const effect = uifRemuneration < 0
    ? `took this month's UIF pay below nil (${formatMoney(uifRemuneration)}), so UIF is nil`
    : `reduced this month's UIF pay to ${formatMoney(uifRemuneration)}`;
  return [{
    code: UIF_CLAWBACK,
    severity: 'warning',
    message: `A clawback of ${formatMoney(clawback)} ${effect}. If that pay was declared for UIF in an earlier month, check `
      + 'that month\'s UI-19 / EMP201 for an over-declaration: SARS refunds the excess to the employer (UIC Act 4 of 2002 '
      + 's8(3)), and the employer must refund the employee\'s share deducted (s7(5)).',
  }];
}
