// Group setup UI, round 4 of the 999r review: the server's 403 "switch to that company" reaches the user (REAL
// assertOk / apiErrorMessage over a scripted apiFetch), and a member row or picker entry that is not the active company
// is shown disabled with the hint, instead of letting the user click into the refusal.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', async () => ({
  ...(await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch')),
  apiFetch: (...a: unknown[]) => fetchMock(...a),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { GroupDetailsTab } from '../../../src/components/accounting/group/GroupDetailsTab';
import { GroupMembersSection } from '../../../src/components/accounting/group/GroupMembersSection';
import type { CompanyGroup, GroupMember } from '../../../src/components/accounting/group/types';

const HERE = '10000000-0000-4000-8000-0000000000a1';
const ELSEWHERE = '10000000-0000-4000-8000-0000000000a2';
const SWITCH = 'Group membership is changed with that company as your active company: switch to it, then repeat the change.';
const refusal = () => new Response(JSON.stringify({ success: false, error: { message: SWITCH } }), { status: 403, headers: { 'Content-Type': 'application/json' } });

const member = (id: string, companyId: string, companyName: string): GroupMember => ({
  id, groupId: 'g1', companyId, companyName, ownershipPct: 100, consolidationMethod: 'full', isHolding: false,
  joinedDate: '2026-03-01', leftDate: null, createdAt: '2026-03-01T00:00:00Z',
});
const members = [member('m1', HERE, 'Here Co'), member('m2', ELSEWHERE, 'Elsewhere Co')];
const group = { id: 'g1', name: 'G', holdingCompanyId: HERE, defaultCurrency: 'ZAR', financialYearStart: 3 } as unknown as CompanyGroup;

function section(onFlash = vi.fn(), activeCompanyId: string | null = HERE) {
  render(<GroupMembersSection group={group} members={members} availableCompanies={[{ id: HERE, name: 'Here Co' }, { id: ELSEWHERE, name: 'Elsewhere Co' }]}
    activeCompanyId={activeCompanyId} onRefresh={vi.fn(async () => undefined)} onFlash={onFlash} />);
  return onFlash;
}
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('confirm', () => true); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('member rows: only the active company\'s row can be changed', () => {
  it('a row that is not the active company is disabled and says to switch; the active one is enabled', () => {
    section();
    const other = rowOf('Elsewhere Co');
    expect(other.textContent).toContain('Switch to Elsewhere Co to change this');
    const buttons = other.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    buttons.forEach((b) => expect(b).toBeDisabled());
    rowOf('Here Co').querySelectorAll('button').forEach((b) => expect(b).toBeEnabled());
    expect(rowOf('Here Co').textContent).not.toContain('Switch to');
  });
  it('ids are compared whatever their case', () => {
    section(vi.fn(), HERE.toUpperCase());
    rowOf('Here Co').querySelectorAll('button').forEach((b) => expect(b).toBeEnabled());
  });
  it('with no active company known, nothing is offered as changeable', () => {
    section(vi.fn(), null);
    document.querySelectorAll('tbody button').forEach((b) => expect(b).toBeDisabled());
  });
  it('the add picker lists a company that is not the active one disabled, with the reason', () => {
    section();
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    const options = Array.from(document.querySelectorAll('select option')) as HTMLOptionElement[];
    const elsewhere = options.find((o) => o.textContent?.includes('Elsewhere Co'))!;
    expect(elsewhere.disabled).toBe(true);
    expect(elsewhere.textContent).toContain('switch to this company to add it');
    expect(options.find((o) => o.textContent === 'Here Co')!.disabled).toBe(false);
  });
});

describe('the server\'s refusal reaches the user (not a generic "Failed to …")', () => {
  it('add, update and remove show the 403 text', async () => {
    const onFlash = section();
    fetchMock.mockImplementation(async () => refusal());
    // remove (active row)
    fireEvent.click(rowOf('Here Co').querySelector('button[title="Remove"]')!);
    await waitFor(() => expect(onFlash).toHaveBeenCalledWith(SWITCH, 'error'));
    onFlash.mockClear();
    // update
    fireEvent.click(rowOf('Here Co').querySelector('button[title="Edit"]')!);
    await act(async () => { fireEvent.click(rowOf('Here Co').querySelector('button[title="Save"]')!); });
    await waitFor(() => expect(onFlash).toHaveBeenCalledWith(SWITCH, 'error'));
    onFlash.mockClear();
    // add
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    fireEvent.change(document.querySelector('select')!, { target: { value: HERE } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^add$/i })); });
    await waitFor(() => expect(onFlash).toHaveBeenCalledWith(SWITCH, 'error'));
  });
  it('a failure with no server message still says what failed', async () => {
    const onFlash = section();
    fetchMock.mockImplementation(async () => new Response('', { status: 500 }));
    fireEvent.click(rowOf('Here Co').querySelector('button[title="Remove"]')!);
    await waitFor(() => expect(onFlash).toHaveBeenCalledWith('Failed to remove member', 'error'));
  });
});

describe('group details tab', () => {
  const props = { members, userCompanies: [{ id: HERE, name: 'Here Co' }, { id: ELSEWHERE, name: 'Elsewhere Co' }], activeCompanyId: HERE,
    onGroupChange: vi.fn(), onMembersRefresh: vi.fn(async () => undefined), onGroupRefresh: vi.fn(async () => undefined) };
  it('the holding company picker of a new group disables a company that is not the active one', () => {
    render(<GroupDetailsTab group={null} {...props} onFlash={vi.fn()} />);
    const options = Array.from(document.querySelectorAll('select option')) as HTMLOptionElement[];
    expect(options.find((o) => o.textContent?.includes('Elsewhere Co'))!.disabled).toBe(true);
    expect(options.find((o) => o.textContent === 'Here Co')!.disabled).toBe(false);
  });
  it('create and save show the server\'s message', async () => {
    const onFlash = vi.fn();
    fetchMock.mockImplementation(async () => refusal());
    const { unmount } = render(<GroupDetailsTab group={null} {...props} onFlash={onFlash} />);
    fireEvent.change(screen.getByPlaceholderText(/acme holdings/i), { target: { value: 'New' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /create group/i })); });
    await waitFor(() => expect(onFlash).toHaveBeenCalledWith(SWITCH, 'error'));
    unmount();
    onFlash.mockClear();
    render(<GroupDetailsTab group={group} {...props} onFlash={onFlash} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });
    await waitFor(() => expect(onFlash).toHaveBeenCalledWith(SWITCH, 'error'));
  });
});
