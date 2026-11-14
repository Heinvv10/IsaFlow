/**
 * The SARS codes of an employee's retirement fund contributions (PAYE 4c): 4001 pension, 4003 provident
 * (BRS PAYE Employer Reconciliation V25.3.0 p. 101), 4006 retirement annuity (p. 102). The one list in
 * TypeScript: the calculator, the certificate and the pay components page import it. The SQL copies
 * (migration 948's CHECK) state the same three codes.
 */
export const RETIREMENT_CONTRIBUTION_CODES = ['4001', '4003', '4006'] as const;

/**
 * The taxable benefits of an employer's fund contributions (wave 5 RF): 3817 pension, 3825 provident, 3828 retirement annuity
 * (BRS V25.3.0 p. 94-95). Assigned as a non-cash earning and deemed paid by the employee (employerContributions.ts).
 */
export const EMPLOYER_FUND_BENEFIT_CODES = ['3817', '3825', '3828'] as const;
