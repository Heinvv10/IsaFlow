/**
 * Follow-up B of PR #1065: since labour lines carry the employee's CC1, the
 * approve dialog can list one account twice ("5210 Site labour" per centre).
 * Each labour row names its cost centre — code and name from the preview's
 * company-scoped `costCentres` map — and an untagged labour row says so, so
 * the rows are told apart. Credit rows carry none. The single-line journal of
 * a company without centres looks as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { RUN_ID, PLAN_URL, PLAN_LINES, planBody, postedJournal, ok } from './payroll/payrollRunFixtures';
import { PayrollApproveDialog } from '@/components/payroll/PayrollApproveDialog';

const CC_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CC_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const labour = (debit: number, cc1Id: string | null, code = '5210', name = 'Site labour') =>
  ({ glAccountId: `gl-${code}`, accountCode: code, accountName: name, debit, credit: 0, description: name, inactiveAccount: false, cc1Id });
const credits = PLAN_LINES.filter((l) => l.credit > 0).map((l) => ({ ...l, cc1Id: null }));
// 5210 carries CC-A, CC-B and an untagged share (an inactive centre's); 5200 only untagged labour.
const TAGGED = [labour(40000, CC_A), labour(20000, CC_B), labour(5000, null), labour(10927.12, null, '5200', 'Salaries & Wages'), ...credits];
const LABELS = { [CC_A]: { code: 'CC-A', name: 'Atlantic' }, [CC_B]: { code: 'CC-B', name: 'Boland' } };

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serve(preview: unknown) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === PLAN_URL) return ok(preview);
    throw new Error(`unexpected fetch ${url}`);
  });
}
const open = () => render(
  <PayrollApproveDialog runId={RUN_ID} period="September 2026" warningCount={0} open onClose={() => {}} onApproved={() => {}} onUncertain={() => {}} />,
);
const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr') as HTMLElement;

describe('approve dialog — the cost centre on each labour row', () => {
  it('names each centre on its own row of the same account, and marks the untagged labour row', async () => {
    serve({ ...planBody(null, { plan: { lines: TAGGED } }), costCentres: LABELS });
    open();
    const a = await rowOf('CC-A · Atlantic');
    const b = await rowOf('CC-B · Boland');
    expect(within(a).getByText('5210')).toBeTruthy();
    expect(within(b).getByText('5210')).toBeTruthy();
    expect(within(a).getByText(/40[\s ]000\.00/)).toBeTruthy();
    expect(within(b).getByText(/20[\s ]000\.00/)).toBeTruthy();
    // The untagged row on 5210 — the account with tagged rows — is told apart from them.
    const untagged = (await rowOf('No cost centre'));
    expect(within(untagged).getByText('5210')).toBeTruthy();
    expect(within(untagged).getByText(/5[\s ]000\.00/)).toBeTruthy();
    // 5200 has no tagged row to be told apart from, and credits never carry a centre.
    expect(within(await rowOf('Salaries & Wages')).queryByText(/cost centre|CC-/)).toBeNull();
    expect(within(await rowOf('PAYE Payable')).queryByText(/cost centre|CC-/)).toBeNull();
  });

  it('a tagged row is labelled whatever its amount; an untagged CREDIT row on that account is never marked', async () => {
    const credit = { ...labour(0, null), accountName: 'Site labour recovery', credit: 300 };
    const lines = [labour(0, CC_A), credit, labour(75927.12, null, '5200', 'Salaries & Wages'), ...credits];
    serve({ ...planBody(null, { plan: { lines } }), costCentres: LABELS });
    open();
    expect(await rowOf('CC-A · Atlantic')).toBeTruthy();
    expect(within(await rowOf('Site labour recovery')).queryByText('No cost centre')).toBeNull();
    expect(screen.queryByText('No cost centre')).toBeNull();
  });

  it('labels the journal already posted when approval re-locks onto it', async () => {
    const posted = { ...postedJournal('je-1'), lines: TAGGED.map(({ glAccountId, accountCode, accountName, debit, credit, cc1Id }) => ({ glAccountId, accountCode, accountName, debit, credit, cc1Id })) };
    serve({ ...planBody(null, { plan: { lines: TAGGED }, posted }), costCentres: LABELS });
    open();
    expect(await screen.findByText(/Already posted/)).toBeTruthy();
    expect(await rowOf('CC-A · Atlantic')).toBeTruthy();
    expect(await rowOf('CC-B · Boland')).toBeTruthy();
  });

  it('a centre the map does not name shows its id, never a blank', async () => {
    serve({ ...planBody(null, { plan: { lines: TAGGED } }), costCentres: { [CC_A]: LABELS[CC_A] } });
    open();
    expect(await rowOf(CC_B)).toBeTruthy();
  });

  it('a journal with no centres shows no cost-centre text at all (as before)', async () => {
    serve({ ...planBody(), costCentres: {} });
    open();
    expect(await screen.findByText('Salaries & Wages')).toBeTruthy();
    expect(screen.queryByText(/cost centre/i)).toBeNull();
  });
});
