/**
 * Forensic-controls step 3 (migration 888): entity change history, by census.
 *
 *  - Every writer of a tracked table, pinned per TABLE over the source tree on
 *    disk (an untracked new writer counts). 888's trigger records every write
 *    whoever makes it, so a new writer is not a hole — it is a new path whose
 *    history a reviewer should know exists (its channel, its actor: a script
 *    or a migration_admin pool records `db:<role>`, `system`). Migrations and
 *    the SQL functions they define are not pinned here; the trigger covers
 *    them too (create_company_with_owner, the 881/885 definers).
 *  - entity_changes is written by nothing but 888's capture and read only by
 *    entityChangeQuery.ts.
 *  - No other migration — whatever its number, since the runner applies any file
 *    not yet applied — names any of 888's objects (`entity_change…`), turns a
 *    tracked table's triggers off (DISABLE / ENABLE REPLICA), or grants ON ALL
 *    TABLES / FUNCTIONS (which would hand app_user INSERT or the capture back).
 *  - Nothing in src / pages / scripts turns triggers off.
 *
 * A TEXT check: a statement built at run time slips past it (the dynamic
 * seeders write through a table variable); the trigger still records those.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, sourceFiles, stripComments, withoutSqlComments } from '../../helpers/sourceCensus';

const MIGRATIONS = 'scripts/migrations/sql/';
const HISTORY_FILE = '888_entity_change_history.sql';

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

/**
 * Another migration may not name any of 888's objects at all (the table, its
 * policy, the capture and its helpers — `entity_change…`): any change to the
 * history is a review event, so it fails here until this census is changed with
 * it. Nor may it switch any trigger but to ENABLE ALWAYS (DISABLE, ENABLE, ENABLE REPLICA),
 * write the history, or grant ON ALL TABLES / FUNCTIONS (that hands app_user
 * INSERT on the history, or EXECUTE on the capture, back).
 */
/**
 * Migrations before 888 that match laterMigrationViolates: the schema-wide grants
 * to app_user (348) and platform_admin (352). They ran before entity_changes and
 * the capture existed, so they reach neither. A new one is a reason to look.
 */
const KNOWN_GRANTS = ['348_rls_and_auth_helpers.sql', '352_platform_admin_role.sql'];

export function laterMigrationViolates(sql: string): boolean {
  return /\bentity_change/i.test(sql)
    // Any trigger switch but ENABLE ALWAYS, on any table, literal or inside a format() string (blind review r2 L-3):
    // DISABLE stops a capture; a plain or REPLICA ENABLE takes it out of ALWAYS, so it no longer fires under replica.
    || /\b(?:disable|enable(?!\s+always\b))(?:\s+replica)?\s+trigger\b/i.test(sql)
    || /\bgrant\b[^;]*\bon\s+all\s+(?:tables|functions|routines)\s+in\s+schema\s+public\b/i.test(sql);
}

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

  // Every migration file but 888 is judged, whatever its number (blind review r2 M-1): the runner applies any
  // file not yet applied, in name order, so a new 887_ or 886b_ that lands after 888 runs after it on prod too.
  it('no other migration touches the history or turns a capture off', () => {
    const found = sourceFiles()
      .filter(({ file }) => file.startsWith(MIGRATIONS) && path.basename(file) !== HISTORY_FILE)
      .filter(({ file, text }) => laterMigrationViolates(code(file, text)))
      .map(({ file }) => path.basename(file));
    expect(found).toEqual(KNOWN_GRANTS);
  });

  // Blind review of #696 (M1): each of these slipped past the first census.
  it.each([
    'ALTER TABLE suppliers ENABLE REPLICA TRIGGER entity_change_capture',
    'ALTER TABLE customers ENABLE REPLICA TRIGGER ALL',
    'ALTER TABLE ONLY public.gl_accounts DISABLE TRIGGER USER',
    'DROP FUNCTION public.entity_change_capture() CASCADE',
    'ALTER TABLE entity_changes DISABLE ROW LEVEL SECURITY',
    'ALTER TABLE entity_changes NO FORCE ROW LEVEL SECURITY',
    'CREATE POLICY wide ON entity_changes FOR SELECT TO app_user USING (true)',
    'DROP POLICY entity_changes_read ON entity_changes',
    'ALTER FUNCTION public.entity_change_capture() SECURITY INVOKER',
    "CREATE OR REPLACE TRIGGER entity_change_capture AFTER INSERT ON suppliers FOR EACH ROW EXECUTE FUNCTION noop()",
    'GRANT EXECUTE ON FUNCTION public.entity_change_capture() TO app_user',
    'DROP TABLE entity_changes',
    'ALTER TABLE entity_changes ALTER COLUMN actor DROP NOT NULL',
    'GRANT INSERT ON ALL TABLES IN SCHEMA public TO app_user',
    'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user',
    'DROP TRIGGER entity_change_capture ON suppliers',
    // Blind review r2 L-3: a DISABLE after other actions, a plain ENABLE (out of ALWAYS), a run-time-built one.
    'ALTER TABLE suppliers ADD COLUMN y int, DISABLE TRIGGER ALL',
    'ALTER TABLE customers ENABLE TRIGGER ALL',
    "EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', t)",
  ])('a migration saying %s is refused', (stmt) => {
    expect(laterMigrationViolates(stmt)).toBe(true);
  });

  it.each(['CREATE TABLE widgets (id uuid)', 'ALTER TABLE suppliers ADD COLUMN x text', 'ALTER TABLE suppliers ENABLE ALWAYS TRIGGER foo',
    'CREATE TRIGGER t BEFORE UPDATE ON widgets FOR EACH ROW EXECUTE FUNCTION f()'])(
    'an unrelated migration (%s) passes', (stmt) => { expect(laterMigrationViolates(stmt)).toBe(false); });

  it('no source file turns triggers off (session_replication_role, DISABLE TRIGGER)', () => {
    const found = nonMigrations()
      .filter(({ file, text }) => /\bsession_replication_role\b|\b(?:disable|enable(?!\s+always\b))(?:\s+replica)?\s+trigger\b/i.test(code(file, text)))
      .map(({ file }) => file);
    // A lint rule that names both in its messages; it turns nothing off.
    expect(found).toEqual(['scripts/ci/oauthTrustFlagRule.ts']);
  });

  it('888 attaches the capture to exactly the tracked tables, ENABLE ALWAYS', () => {
    const sql = readFileSync(path.join(ROOT, MIGRATIONS, HISTORY_FILE), 'utf8');
    const values = /FROM \(VALUES([\s\S]*?)\) v\(tbl, typ\)/.exec(sql)![1]!;
    const tables = [...values.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual([...TRACKED].sort());
    expect(sql).toMatch(/ENABLE ALWAYS TRIGGER entity_change_capture/);
  });
});
