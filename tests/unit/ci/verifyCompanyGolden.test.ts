// The post-deploy suite proves its own company when it runs as the verify user: the email decides to check, the data decides the answer.
import { describe, expect, it } from 'vitest';
import { approverCompanyProblems, budgetYearWarning, budgetYears, isVerifyLogin, verifyCompanyProblems } from '../../e2e/golden-paths/helpers/verifyCompany';
import { MIGRATION_SANDBOX_ONBOARDING_ID, sandboxSetupBody } from '../../e2e/golden-paths/helpers/sandboxSetup';

const home = { companyId: 'c1', companyName: 'Deploy Verification', isDemo: true };
const sandbox = { companyId: 'c2', companyName: '0GP Golden Migration Sandbox', isDemo: true };

describe('isVerifyLogin', () => {
  it('is the verify address, any case, and nothing else', () => {
    expect(isVerifyLogin({ E2E_ADMIN_EMAIL: 'Deploy-Verify@isaflow.co.za' })).toBe(true);
    expect(isVerifyLogin({ E2E_ADMIN_EMAIL: 'admin@isaflow.co.za' })).toBe(false);
    expect(isVerifyLogin({})).toBe(false);
  });
});

describe('verifyCompanyProblems', () => {
  it('is empty for the verify company, active, with its is_demo sandbox beside it', () => {
    expect(verifyCompanyProblems([home, sandbox], 'c1')).toEqual([]);
  });

  it('fails when the active company is another one, even a demo one', () => {
    expect(verifyCompanyProblems([home, sandbox], 'c2').join()).toMatch(/not "Deploy Verification"/);
  });

  it('fails when the active company has the name but is not flagged is_demo', () => {
    expect(verifyCompanyProblems([{ ...home, isDemo: false }], 'c1').join()).toMatch(/not flagged is_demo/);
  });

  it('fails when the user owns any company that is not is_demo (a spec would write somewhere real), naming it', () => {
    const real = { companyId: 'c3', companyName: 'Velocity Fibre', isDemo: false };
    expect(verifyCompanyProblems([home, real], 'c1').join()).toMatch(/not is_demo: "Velocity Fibre"/);
    expect(verifyCompanyProblems([home, { ...sandbox, isDemo: undefined }], 'c1').join()).toMatch(/not is_demo/);
  });

  it('fails when the session has no active company or one the user is not in', () => {
    expect(verifyCompanyProblems([home], '').join()).toMatch(/none/);
    expect(verifyCompanyProblems([home], 'zzz').join()).toMatch(/not one of the user's companies/);
  });
});

describe('sandboxSetupBody', () => {
  it('is the one request the spec and the provisioner both send: fixed key, entity other, standard chart', () => {
    expect(sandboxSetupBody({ name: 'X', onboardingId: MIGRATION_SANDBOX_ONBOARDING_ID })).toEqual({
      requestKey: MIGRATION_SANDBOX_ONBOARDING_ID, entityType: 'other', coaTemplate: 'isaflow_standard',
      company: { name: 'X', vatPeriod: 'bi-monthly', vatNumber: '4000000000' }, people: [], documents: [],
    });
  });
});

describe('the global-setup failure for a company that is not is_demo', () => {
  it('names the company and points at the sandbox list and the census that keep specs and provisioner in step', () => {
    const msg = verifyCompanyProblems([home, { companyId: 'c9', companyName: '0GP Golden Something Sandbox', isDemo: false }], 'c1').join(' ');
    expect(msg).toContain('"0GP Golden Something Sandbox"');
    expect(msg).toContain('scripts/deploy/verifyCompany/sandboxes.ts');
    expect(msg).toContain('verifyCompanySandboxCensus.test.ts');
    expect(msg).toContain('// golden:dev-only');
  });
});

describe('approverCompanyProblems', () => {
  it('is empty for exactly the Deploy Verification company', () => {
    expect(approverCompanyProblems([home])).toEqual([]);
  });
  it('fails for any other membership, a missing one, or a non-demo company of that name', () => {
    expect(approverCompanyProblems([home, sandbox]).join()).toMatch(/must be exactly/);
    expect(approverCompanyProblems([]).join()).toMatch(/none/);
    expect(approverCompanyProblems([sandbox]).join()).toMatch(/must be exactly/);
    expect(approverCompanyProblems([{ ...home, isDemo: false }]).join()).toMatch(/must be exactly/);
  });
});

describe('budgetYearWarning', () => {
  const have = (...years: number[]) => (y: number) => years.includes(y);
  const d = (iso: string) => new Date(`${iso}T10:00:00Z`);

  it('budget year labels follow the March year', () => {
    expect(budgetYears(d('2026-11-18'))).toMatchObject({ current: 2027, next: 2028 });
    expect(budgetYears(d('2027-02-10'))).toMatchObject({ current: 2027, next: 2028 });
    expect(budgetYears(d('2027-03-01'))).toMatchObject({ current: 2028, next: 2029 });
    expect(budgetYears(d('2026-11-18')).nextStarts.toISOString().slice(0, 10)).toBe('2027-03-01');
  });

  it('is silent when both years have a version, or the next year is still far off', () => {
    expect(budgetYearWarning(d('2026-11-18'), have(2027, 2028))).toBeNull();
    expect(budgetYearWarning(d('2026-11-18'), have(2027))).toBeNull(); // 103 days to 2027-03-01
  });

  it("warns within 60 days of the next year's start when it has no version, naming the year, the days and the remedy", () => {
    const w = budgetYearWarning(d('2027-01-15'), have(2027))!; // 45 days to 1 March
    expect(w).toMatch(/^WARNING: FY2028 starts in 45 day\(s\)/);
    expect(w).toContain('provision-verify-company.sh');
    expect(budgetYearWarning(d('2026-12-31'), have(2027))).toMatch(/FY2028 starts in 60 day/); // the boundary
    expect(budgetYearWarning(d('2026-12-30'), have(2027))).toBeNull(); // 61
  });

  it('warns at once when the current year has no version (the specs would skip)', () => {
    expect(budgetYearWarning(d('2026-11-18'), have(2028))).toMatch(/^WARNING: .* no budget version for FY2027, the current budget year/);
  });
});
