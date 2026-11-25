/**
 * The audit_log entity types whose rows carry one person's pay or HR data in `changes` / `metadata` (an employee's email, a tax
 * directive's dates and amounts, a garnishee order's instalment and court reference, a payslip delivery, the employee portal's email
 * address). A person without Payroll read does not see them in the audit log, its entity history or its CSV export
 * (#1656 round 8). tests/unit/security/auditPayrollTypesCensus.test.ts derives every type the code writes (logAudit / logAuditOrThrow,
 * type-checker resolved) and fails on a payroll-scope write whose type is neither listed here nor named there as not personal,
 * so a new type cannot leak by omission.
 */
export const PAYROLL_AUDIT_ENTITY_TYPES: readonly string[] = [
  'employee_portal_access',
  'payroll_bank_detail',
  'payroll_bank_duplicates',
  'payroll_bank_file',
  'payroll_company_settings',
  'payroll_component',
  'payroll_employee',
  'payroll_employee_component',
  'payroll_explanation',
  'payroll_fringe_benefit',
  'payroll_garnishee_order',
  'payroll_payslips',
  'payroll_run',
  'payroll_run_frequency_change',
  'payslip_email',
  // W29 (#1901 M2): an acknowledged share beside a once-off; its pairKey names one employee's rows and amounts.
  'recurring_share_ack',
  'tax_directive',
];
