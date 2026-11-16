// The wave-6 golden QA user: the login the specs read and the membership the provisioner insists on.
import { describe, expect, it } from 'vitest';
import { membershipProblems, W6_COMPANY_NAME } from '../../../scripts/ci/golden/provision-w6-qa';
import { readW6Qa } from '../../e2e/golden-paths/helpers/w6QaUser';

const ID = '11111111-2222-4333-8444-555555555555';
const sandbox = { id: ID, name: W6_COMPANY_NAME, role: 'owner' };

describe('membershipProblems', () => {
  it('accepts exactly the sandbox, as owner', () => expect(membershipProblems([sandbox])).toEqual([]));
  it('refuses a second company', () => {
    expect(membershipProblems([sandbox, { id: 'x', name: 'ISAFlow Demo', role: 'owner' }])[0]).toMatch(/belongs to 2 companies/);
  });
  it('refuses no company, another company, and a non-owner role', () => {
    expect(membershipProblems([])[0]).toMatch(/belongs to 0 companies/);
    expect(membershipProblems([{ ...sandbox, name: 'Other' }])[0]).toMatch(/not "0W6 Golden Sandbox"/);
    expect(membershipProblems([{ ...sandbox, role: 'viewer' }])[0]).toMatch(/viewer, not owner/);
  });
});

describe('readW6Qa', () => {
  const full = { GOLDEN_QA_W6_EMAIL: 'golden-qa-w6@isaflow.dev', GOLDEN_QA_W6_PASSWORD: 'p', GOLDEN_QA_W6_COMPANY_ID: ID };
  it('reads the three variables', () => expect(readW6Qa(full)).toEqual({ email: full.GOLDEN_QA_W6_EMAIL, password: 'p', companyId: ID }));
  it('names what is missing instead of falling back', () => {
    expect(() => readW6Qa({ ...full, GOLDEN_QA_W6_COMPANY_ID: '' })).toThrow(/missing: GOLDEN_QA_W6_COMPANY_ID/);
    expect(() => readW6Qa({})).toThrow(/missing: GOLDEN_QA_W6_EMAIL, GOLDEN_QA_W6_PASSWORD, GOLDEN_QA_W6_COMPANY_ID/);
  });
});
