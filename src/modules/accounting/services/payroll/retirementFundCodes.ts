/**
 * The SARS codes of an employee's retirement fund contributions (PAYE 4c): 4001 pension, 4003 provident
 * (BRS PAYE Employer Reconciliation V25.3.0 p. 101), 4006 retirement annuity (p. 102). The one list in
 * TypeScript: the calculator, the certificate and the pay components page import it. The SQL copies
 * (migration 948's CHECK) state the same three codes.
 */
export const RETIREMENT_CONTRIBUTION_CODES = ['4001', '4003', '4006'] as const;
