// The post-deploy suite proves its own company when it runs as the verify user: the email decides to check, the data decides the answer.
import { describe, expect, it } from 'vitest';
import { isVerifyLogin, verifyCompanyProblems } from '../../e2e/golden-paths/helpers/verifyCompany';
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
