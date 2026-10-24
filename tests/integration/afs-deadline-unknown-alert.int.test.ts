// tests/integration/afs-deadline-unknown-alert.int.test.ts
//
// THE "DEADLINE CANNOT BE ASSESSED" ALERT, OVER ITS WHOLE LIFE, ON REAL ROWS.
//
// `afs_filing_deadline_unknown` is raised for a company with an open AFS and
// no usable financial year start. It was never withdrawn once the year start
// was set — the page went on saying the deadline could not be assessed beside
// a deadline reminder — and it came back on the next run after somebody
// dismissed it. Both are statements about rows over several runs, which a
// stubbed `sql` cannot show.
//
// WHAT MAKES IT UNKNOWN NOW (migration 940). The deadline is six months after
// the end of the company's stored financial year with the statement's label
// (gl/fiscalYearRegistry). A NULL financial_year_start no longer makes it
// unknown: the year template reads NULL as March, like every other reader. What
// remains is a statement labelled with a year no financial year carries — the
// label a change of year end skipped. Each company here has FY2025
// (Jan-Dec 2025) and a 14-month transition FY2026 (Jan 2026 - Feb 2027), so
// FY2027 belongs to no year (the next one is FY2028, from March 2027). The
// tests that set and cleared the year start now relabel the open statement
// between the skipped FY2027 and the real FY2026; the lifecycle asserted is
// unchanged.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import {
  detectAndFireAfsAlerts, dismissAfsAlert, getActiveAfsAlerts,
} from '@/modules/accounting/services/afs/complianceAlertService';

const DATABASE_URL = process.env.DATABASE_URL;
const COMPANY = '00000000-0000-0000-0000-0000005e0a01';
const OTHER = '00000000-0000-0000-0000-0000005e0b01';
const USER = 'pr349-deadline-alert-user';
const UNKNOWN = 'afs_filing_deadline_unknown';

// Only on a throwaway database: this seeds companies, a user and statements.
const describeIfDb = isDisposableDb(DATABASE_URL) ? describe : describe.skip;

describeIfDb('the alert for a filing deadline that cannot be assessed', () => {
  let admin: Pool;

  /** The open statement's year: a real one, or the label the transition skipped. */
  const SKIPPED = 2027;
  const REAL = 2026;
  const setStatementYear = (company: string, label: number) =>
    admin.query(`UPDATE afs_documents SET fiscal_year = $2 WHERE company_id = $1`, [company, label]);
  const rows = async (company: string) => (await admin.query(
    `SELECT dismissed_at IS NULL AS active, dismissed_by FROM compliance_alerts
      WHERE company_id = $1 AND alert_type = $2 ORDER BY fired_at`, [company, UNKNOWN])).rows;
  const activeTypes = async (company: string) => (await getActiveAfsAlerts(company)).map((a) => a.alertType);

  beforeAll(async () => {
    assertDisposableDb('This test inserts and deletes companies, a user, AFS documents and alerts.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, 'pr349-deadline-alert@fixture.test')`, [USER]);
    for (const company of [COMPANY, OTHER]) {
      await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, 'Deadline Alert Fixture', true)`, [company]);
      await admin.query(
        `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
         VALUES ($1, 2025, '2025-01-01', '2025-12-31', 'normal'), ($1, 2026, '2026-01-01', '2027-02-28', 'transition')`,
        [company]);
      await admin.query(
        `INSERT INTO afs_documents (company_id, fiscal_year, document_type, reporting_framework, status)
         VALUES ($1, $2, 'afs', 'ifrs_smes', 'draft')`, [company, SKIPPED]);
    }
  }, 60000);

  beforeEach(async () => {
    await admin.query('DELETE FROM compliance_alerts WHERE company_id = ANY($1)', [[COMPANY, OTHER]]);
    await setStatementYear(COMPANY, SKIPPED);
    await setStatementYear(OTHER, SKIPPED);
  });

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('is raised once, however many times the detector runs', async () => {
    await detectAndFireAfsAlerts(COMPANY);
    await detectAndFireAfsAlerts(COMPANY);
    expect(await rows(COMPANY)).toEqual([{ active: true, dismissed_by: null }]);
  });

  it('is withdrawn when the statement is for a year the company has', async () => {
    await detectAndFireAfsAlerts(COMPANY);
    await setStatementYear(COMPANY, REAL);
    await detectAndFireAfsAlerts(COMPANY);
    expect(await activeTypes(COMPANY)).not.toContain(UNKNOWN);
    // Withdrawn by the system, not dismissed by a person.
    expect(await rows(COMPANY)).toEqual([{ active: false, dismissed_by: null }]);
  });

  it('comes back if the statement is for a missing year again after a withdrawal', async () => {
    await detectAndFireAfsAlerts(COMPANY);
    await setStatementYear(COMPANY, REAL);
    await detectAndFireAfsAlerts(COMPANY);
    await setStatementYear(COMPANY, SKIPPED);
    await detectAndFireAfsAlerts(COMPANY);
    expect(await activeTypes(COMPANY)).toContain(UNKNOWN);
  });

  it('stays dismissed: a later run does not raise it again while nothing has changed', async () => {
    await detectAndFireAfsAlerts(COMPANY);
    const [alert] = (await getActiveAfsAlerts(COMPANY)).filter((a) => a.alertType === UNKNOWN);
    await dismissAfsAlert(COMPANY, alert!.id, USER);
    await detectAndFireAfsAlerts(COMPANY);
    await detectAndFireAfsAlerts(COMPANY);
    expect(await rows(COMPANY)).toEqual([{ active: false, dismissed_by: USER }]);
  });

  it('is withdrawn when the company has no statement left open', async () => {
    await detectAndFireAfsAlerts(COMPANY);
    await admin.query(`UPDATE afs_documents SET status = 'filed' WHERE company_id = $1`, [COMPANY]);
    try {
      await detectAndFireAfsAlerts(COMPANY);
      expect(await activeTypes(COMPANY)).not.toContain(UNKNOWN);
    } finally {
      await admin.query(`UPDATE afs_documents SET status = 'draft' WHERE company_id = $1`, [COMPANY]);
    }
  });

  it('touches no other company\'s alert, raising, dismissing or withdrawing', async () => {
    await detectAndFireAfsAlerts(OTHER);
    await detectAndFireAfsAlerts(COMPANY);
    await setStatementYear(COMPANY, REAL);
    await detectAndFireAfsAlerts(COMPANY);
    expect(await rows(OTHER)).toEqual([{ active: true, dismissed_by: null }]);
    // And another company's dismissal does not silence this one's.
    const [theirs] = (await getActiveAfsAlerts(OTHER)).filter((a) => a.alertType === UNKNOWN);
    await dismissAfsAlert(OTHER, theirs!.id, USER);
    await setStatementYear(COMPANY, SKIPPED);
    await detectAndFireAfsAlerts(COMPANY);
    expect(await activeTypes(COMPANY)).toContain(UNKNOWN);
  });
});

async function cleanup(admin: Pool): Promise<void> {
  const companies = [COMPANY, OTHER];
  await admin.query('DELETE FROM compliance_alerts WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM afs_documents WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM fiscal_years WHERE company_id = ANY($1)', [companies]);
  await admin.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
  await admin.query('DELETE FROM users WHERE id = $1', [USER]);
}
