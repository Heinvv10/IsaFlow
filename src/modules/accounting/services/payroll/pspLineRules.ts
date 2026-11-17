/**
 * What a personal service provider's line may carry, and what its flat rate is applied to (wave 6 PSP, review of #1566).
 *
 * - Base: the payment before any deduction. Para 2(4) of the Fourth Schedule lets an employer deduct s11F retirement
 *   contributions and s18A donations from an EMPLOYEE's remuneration; a company or trust is no fund member and makes no
 *   donation through payroll, so neither shrinks a PSP's base. A non-cash fringe benefit is not in the base either: the
 *   Seventh Schedule's para 1 "employee" excludes a company (a trust: UNVERIFIED, see below), so there is no benefit to tax.
 * - Refused components (PSP_COMPONENT_REFUSED): a retirement fund contribution (4001 / 4003 / 4006, or the employer's
 *   3817 / 3825 / 3828), an s18A donation (4030), a fringe benefit (any 38xx code, or a non-cash earning) and a loan
 *   (LOAN, or the 3801 loan benefit). Refused at assignment and at calculate (pspComponentGuard, 409), and an error on the
 *   line should one reach the engine another way.
 *   UNVERIFIED for a trust: the Seventh Schedule para 1 "employee" means "any person (other than a company) who receives
 *   any remuneration"; a trust is not a company, so a trust PSP may be an "employee" there. Refused for both, pending a ruling.
 */
import type { EmployeeComponent, ValidationResult } from './payrollTypes';
import { normaliseSarsCode } from './payeAnnualPayment';
import { EMPLOYER_FUND_BENEFIT_CODES, RETIREMENT_CONTRIBUTION_CODES } from './retirementFundCodes';

export type PspRefusedKind = 'retirement fund contribution' | 's18A donation' | 'fringe benefit' | 'loan';

/** Why a component may not be on a PSP's pay, or null when it may. */
export function pspRefusedKind(c: { sarsSourceCode: string; componentType: string }, isNonCash = false): PspRefusedKind | null {
  const code = normaliseSarsCode(c.sarsSourceCode);
  if ((RETIREMENT_CONTRIBUTION_CODES as readonly string[]).includes(code)) return 'retirement fund contribution';
  if ((EMPLOYER_FUND_BENEFIT_CODES as readonly string[]).includes(code)) return 'retirement fund contribution';
  if (code === '4030') return 's18A donation';
  if (code === 'LOAN' || code === '3801') return 'loan';
  if (/^38\d\d$/.test(code) || (isNonCash && c.componentType === 'earning')) return 'fringe benefit';
  return null;
}

/** The refusal's wording, naming each component and why. */
export function pspRefusalMessage(who: string, items: ReadonlyArray<{ name: string; kind: PspRefusedKind }>): string {
  const list = items.map((i) => `${i.name} (${i.kind})`).join(', ');
  return `${who} is a personal service provider (a company or trust), which cannot carry ${list}: a company or trust is no `
    + 'retirement fund member, takes no s18A deduction through payroll (Fourth Schedule para 2(4)), and is not an "employee" '
    + 'for fringe benefits or loans (Seventh Schedule para 1; a trust: unverified). End those components, or change the tax status.';
}

/** Refused before any write (assignment or calculate): answered 409 PSP_COMPONENT_REFUSED (api-error-handler). */
export class PspComponentRefused extends Error {
  readonly code = 'PSP_COMPONENT_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'PspComponentRefused';
  }
}

/** The line's own error for a refused component that reached the engine (it blocks approval like any line error). */
export function pspComponentResults(components: readonly EmployeeComponent[]): ValidationResult[] {
  const items = components.flatMap((c) => {
    const kind = pspRefusedKind(c.component, c.isNonCash === true);
    return kind && c.amount !== 0 ? [{ name: c.component.name, kind }] : [];
  });
  if (items.length === 0) return [];
  return [{ code: 'PSP_COMPONENT_REFUSED', severity: 'error', message: pspRefusalMessage('This payee', items) }];
}

/**
 * The flat rate's base: the month's remuneration before any deduction (periodic and annual, each floored at nil, as
 * remunerationBeforeDeductions gives them), less the non-cash earnings in it.
 */
export function pspPayeBase(remuneration: { periodic: number; annualPayment: number }, components: readonly EmployeeComponent[]): number {
  const nonCash = components
    .filter((c) => c.isNonCash === true && c.component.componentType === 'earning' && c.component.isTaxable)
    .reduce((t, c) => t + c.amount * (c.payeInclusionRate ?? 1), 0);
  return Math.max(0, remuneration.periodic + remuneration.annualPayment - nonCash);
}

/**
 * The payslip's tax basis for a PSP's line, from the line's own stored flag (never the employee's status today):
 * "Personal service provider (company): PAYE at 27%, no UIF". Null for any other line.
 */
export function pspTaxBasis(results: unknown): string | null {
  if (!Array.isArray(results)) return null;
  const flag = results.find((r): r is { psp?: { entity: string; rate: number } } =>
    typeof r === 'object' && r !== null && (r as { code?: unknown }).code === 'PAYE_OUTSIDE_TABLES'
    && (r as { treatment?: unknown }).treatment === 'flat_psp');
  if (!flag) return null;
  const directed = results.some((r) => (r as { treatment?: unknown })?.treatment === 'directive');
  const entity = flag.psp?.entity ?? 'company or trust';
  const rate = flag.psp ? `${Math.round(flag.psp.rate * 10_000) / 100}%` : 'a flat rate';
  return `Personal service provider (${entity}): PAYE ${directed ? 'as the IRP3(b) directive directs' : `at ${rate}`}, no UIF`;
}
