/**
 * Forensic-controls step 3 (migration 890): entity change history, by census.
 *
 *  - Every writer of a tracked table, pinned per TABLE over the source tree on
 *    disk (an untracked new writer counts). 890's trigger records every write
 *    whoever makes it, so a new writer is not a hole — it is a new path whose
 *    history a reviewer should know exists (its channel, its actor: a script
 *    or a migration_admin pool records `db:<role>`, `system`). Migrations and
 *    the SQL functions they define are not pinned here; the trigger covers
 *    them too (create_company_with_owner, the 881/885 definers).
 *  - entity_changes is written by nothing but 890's capture and read only by
 *    entityChangeQuery.ts.
 *  - No later migration drops or disables the capture, alters, re-grants or
 *    views the history, or grants ON ALL TABLES (which would hand app_user
 *    INSERT back).
 *  - Nothing in src / pages / scripts turns triggers off.
 *
 * A TEXT check: a statement built at run time slips past it (the dynamic
 * seeders write through a table variable); the trigger still records those.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, migrationNumber, sourceFiles, stripComments, withoutSqlComments } from '../../helpers/sourceCensus';

const MIGRATIONS = 'scripts/migrations/sql/';
const HISTORY_FROM = 890;

const S = 'src/modules/accounting/services/';
const WRITERS: Record<string, string[]> = {
  suppliers: [
    'pages/api/accounting/supplier-merge.ts', 'scripts/import-sage-britech.ts', 'scripts/qa-seed/parties.ts',
    'scripts/qa-seed/reset.ts', 'scripts/seed-prd05-qa-data.ts', `${S}ap/supplierPaymentAuthors.ts`,
    `${S}capture/supplierGraphService.ts`, `${S}core/duplicateMergeService.ts`, `${S}core/migrationContactService.ts`,
    `${S}core/migrationExecuteContacts.ts`, `${S}core/softDeleteRowOps.ts`, `${S}core/softDeleteService.ts`,
    `${S}core/supplierWriteService.ts`, 'src/modules/admin/services/sageMigrationCommitService.ts',
  ],
  customers: [
    'pages/api/accounting/customers-bulk.ts', 'scripts/import-sage-britech.ts', 'scripts/qa-seed/parties.ts',
    'scripts/qa-seed/reset.ts', 'scripts/seed-phase5-wipe.ts', 'scripts/simulate-fy2026-workflows.ts',
    `${S}ar/customerMergeService.ts`, `${S}core/customerWriteService.ts`, `${S}core/migrationContactService.ts`,
    `${S}core/migrationExecuteContacts.ts`, `${S}core/softDeleteRowOps.ts`, `${S}core/softDeleteService.ts`,
    `${S}gl/dimensions/dimensionDefaultsService.ts`, 'src/modules/admin/services/sageMigrationCommitService.ts',
  ],
  gl_accounts: [
    'pages/api/accounting/bank-accounts.ts', 'scripts/cleanup-demo-data.ts', 'scripts/import-sage-britech.ts',
    'scripts/large-scale-seed.ts', 'scripts/qa-create-blitz-bank.ts', 'scripts/qa-create-brighttech-bank.ts',
    'scripts/qa-create-velofibre-bank.ts', 'scripts/qa-seed-bank-account.ts', 'scripts/qa-seed-blitz-coa.ts',
    'scripts/qa-seed/coa.ts', 'scripts/qa-seed/reset.ts', 'scripts/qa-test-bank-delete-balance.ts',
    'scripts/qa-verify-bank-sprint.ts', 'scripts/seed-demo-data.ts', 'scripts/seed-phase5-wipe.ts', 'scripts/stress-test.ts',
    `${S}bank/bankOpeningBalanceService.ts`, `${S}core/migrationCoaService.ts`, `${S}core/migrationExecuteService.ts`,
    `${S}core/migrationRollbackService.ts`, `${S}gl/accountMergeService.ts`, `${S}gl/accountReclassifyService.ts`,
    `${S}gl/chartOfAccountsImportService.ts`, `${S}gl/chartOfAccountsService.ts`, `${S}gl/defaultAccountsService.ts`,
    `${S}gl/dimensions/dimensionDefaultsService.ts`, `${S}gl/openingBalanceEquityService.ts`,
    'src/modules/admin/services/sageMigrationOrchestrator.ts',
  ],
  payroll_employees: [
    'scripts/seed-phase5-payroll.ts', 'scripts/seed-phase5-wipe.ts', `${S}core/costCentreService.ts`,
    `${S}payroll/equityReportService.ts`, `${S}payroll/payScaleService.ts`, `${S}payroll/payrollBulkEmployeeService.ts`,
    `${S}payroll/payrollEmployeeService.ts`, `${S}payroll/payrollTerminationService.ts`,
  ],
  company_users: [
    'pages/api/invitations/[token]/accept.ts', 'pages/api/invite/[token].ts', 'scripts/large-scale-seed.ts',
    'scripts/provision-isademo2.ts', 'scripts/stress-test.ts', `${S}core/userAccessService.ts`,
    `${S}core/userInvitationService.ts`, 'src/modules/admin/services/adminUserActionsService.ts',
    'src/modules/onboarding/services/tenantProvisioningService.ts',
  ],
  company_invitations: [
    'pages/api/invitations/[token]/accept.ts', 'pages/api/invitations/index.ts', 'pages/api/invitations/revoke/[id].ts',
    'pages/api/invite/[token].ts', `${S}core/userInvitationService.ts`,
  ],
  company_user_permissions: ['src/lib/auth/permissionService.ts'],
  companies: [
    'pages/api/accounting/afs/pis-score.ts', 'pages/api/accounting/chase-settings.ts', 'pages/api/accounting/cipc-annual-return.ts',
    'pages/api/accounting/company-logo.ts', 'pages/api/admin/billing/payg/[companyId]/eligibility.ts',
    'pages/api/admin/companies/bulk-action.ts', 'scripts/large-scale-seed.ts', 'scripts/provision-isademo2.ts',
    'scripts/qa-cleanup-run.ts', 'scripts/stress-test.ts', `${S}capture/bankTxQueryService.ts`, `${S}core/companyService.ts`,
    'src/modules/admin/services/adminCompanyService.ts', 'src/modules/admin/services/trialService.ts',
    'src/modules/onboarding/services/tenantProvisioningService.ts',
  ],
  // Written only through 881/885's SECURITY DEFINER functions (approvalRuleWriteCensus pins their one caller).
  approval_rules: [],
  approval_enforcement: [],
};
export const TRACKED = Object.keys(WRITERS);

const table = (t: string) => String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?${t}"?\b`;
const writes = (t: string) => new RegExp(
  String.raw`\b(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|copy)\s+${table(t)}`, 'i');
const code = (file: string, text: string) => withoutSqlComments(stripComments(text, file));
const nonMigrations = () => sourceFiles().filter(({ file }) => !file.startsWith(MIGRATIONS));

describe('entity change history (census)', () => {
  it.each(TRACKED)('every writer of %s is pinned', (t) => {
    const re = writes(t);
    const found = nonMigrations().filter(({ file, text }) => re.test(code(file, text))).map(({ file }) => file).sort();
    expect(found).toEqual([...WRITERS[t]!].sort());
  });

  it('nothing writes entity_changes, and only entityChangeQuery.ts reads it', () => {
    const touching = nonMigrations().filter(({ file, text }) => /\bentity_changes\b/.test(code(file, text))).map(({ file }) => file);
    expect(touching).toEqual(['src/modules/accounting/services/core/entityChanges/entityChangeQuery.ts']);
    const [query] = nonMigrations().filter(({ file }) => file === touching[0]);
    expect(writes('entity_changes').test(code(query!.file, query!.text))).toBe(false);
  });

  it('no later migration drops the capture, rewrites the history, or grants it back', () => {
    const REFUSED = [
      /\bdrop\s+trigger\b[^;]*\bentity_change/i,
      /\b(?:disable|enable(?!\s+always))\s+trigger\b[^;]*\bentity_change/i,
      /\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?"?(?:entity_changes|suppliers|customers|gl_accounts|payroll_employees|company_users|company_invitations|company_user_permissions|companies|approval_rules|approval_enforcement)"?\s+disable\s+trigger\b/i,
      /\bgrant\b[^;]*\bon\s+(?:table\s+)?(?:[\w".\s]+,\s*)*(?:public\.)?"?entity_changes\b/i,
      /\bgrant\b[^;]*\bon\s+all\s+(?:tables|functions)\s+in\s+schema\s+public\b/i,
      /\balter\s+(?:table|function)\s+[^;]*\bentity_change\w*\b[^;]*\bowner\b/i,
      /\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|recursive|materialized)\s+)*view\b[^;]*\bentity_changes\b/i,
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?entity_change/i,
      writes('entity_changes'),
    ];
    const later = sourceFiles().filter(({ file }) => file.startsWith(MIGRATIONS) && migrationNumber(file) > HISTORY_FROM);
    const found = later.filter(({ file, text }) => REFUSED.some((re) => re.test(code(file, text)))).map(({ file }) => file);
    expect(found).toEqual([]);
  });

  it('no source file turns triggers off (session_replication_role, DISABLE TRIGGER)', () => {
    const found = nonMigrations()
      .filter(({ file, text }) => /\bsession_replication_role\b|\bdisable\s+trigger\b/i.test(code(file, text)))
      .map(({ file }) => file);
    // A lint rule that names both in its messages; it turns nothing off.
    expect(found).toEqual(['scripts/ci/oauthTrustFlagRule.ts']);
  });

  it('890 attaches the capture to exactly the tracked tables, ENABLE ALWAYS', () => {
    const sql = readFileSync(path.join(ROOT, MIGRATIONS, '890_entity_change_history.sql'), 'utf8');
    const values = /FROM \(VALUES([\s\S]*?)\) v\(tbl, typ\)/.exec(sql)![1]!;
    const tables = [...values.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual([...TRACKED].sort());
    expect(sql).toMatch(/ENABLE ALWAYS TRIGGER entity_change_capture/);
  });
});
