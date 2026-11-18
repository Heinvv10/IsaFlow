// Group setup UI, round 4 of the 999r review: the server's 403 "switch to that company" reaches the user (REAL
// assertOk / apiErrorMessage over a scripted apiFetch), and a member row or picker entry that is not the active company
// is shown disabled with the hint, instead of letting the user click into the refusal.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', async () => ({
  ...(await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch')),
  apiFetch: (...a: unknown[]) => fetchMock(...a),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { GroupDetailsTab } from '../../../src/components/accounting/group/GroupDetailsTab';
import { useLiveActiveCompanyId } from '../../../src/components/accounting/group/useLiveActiveCompanyId';
import { COMPANY_STORAGE_KEY } from '../../../src/contexts/companyModel';
import { GroupMembersSection } from '../../../src/components/accounting/group/GroupMembersSection';
import type { CompanyGroup, GroupMember } from '../../../src/components/accounting/group/types';

const HERE = '10000000-0000-4000-8000-0000000000a1';
const ELSEWHERE = '10000000-0000-4000-8000-0000000000a2';
const THIRD = '10000000-0000-4000-8000-0000000000a3';
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
  it('each disabled action has its own name, the action and the reason', () => {
    section();
    const [edit, remove] = Array.from(rowOf('Elsewhere Co').querySelectorAll('button'));
    expect(edit!.getAttribute('aria-label')).toBe('Edit - switch to Elsewhere Co to change this');
    expect(remove!.getAttribute('aria-label')).toBe('Remove - switch to Elsewhere Co to change this');
    expect(screen.getByRole('button', { name: 'Edit - switch to Elsewhere Co to change this' })).toBeDisabled();
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
    await waitFor(() => expect(onFlash).toHaveBeenCalledWith('Could not remove the member - try again', 'error'));
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

describe('no active company loaded: a load-error state with a retry, not a misleading "switch to" everywhere (round 5)', () => {
  it('shows the alert and Retry, and rows say the company has not loaded', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    section(vi.fn(), null);
    expect(screen.getByRole('alert').textContent).toContain('active company could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalled();
    expect(rowOf('Elsewhere Co').textContent).not.toMatch(/switch to/i);
    expect(rowOf('Elsewhere Co').textContent).toContain('has not loaded');
    expect(screen.getByRole('button', { name: 'Edit Elsewhere Co - your active company has not loaded' })).toBeDisabled();
  });
  it('shows no alert when the active company is known', () => {
    section();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('another tab switches company: this tab\'s gating follows (round 5)', () => {
  const store = (id: string) => window.localStorage.setItem(COMPANY_STORAGE_KEY, JSON.stringify({ id, name: 'x', isDemo: false }));
  afterEach(() => window.localStorage.clear());
  it('the hook re-reads the active company on a storage event, on focus and when the tab becomes visible', () => {
    store(HERE);
    const { result } = renderHook(() => useLiveActiveCompanyId(HERE));
    expect(result.current).toBe(HERE);
    act(() => { store(ELSEWHERE); window.dispatchEvent(new StorageEvent('storage', { key: COMPANY_STORAGE_KEY })); });
    expect(result.current).toBe(ELSEWHERE);
    act(() => { store(HERE); window.dispatchEvent(new Event('focus')); });
    expect(result.current).toBe(HERE);
    act(() => { store(ELSEWHERE); document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBe(ELSEWHERE);
  });
  it('an unrelated storage key changes nothing', () => {
    store(HERE);
    const { result } = renderHook(() => useLiveActiveCompanyId(HERE));
    act(() => { store(ELSEWHERE); window.dispatchEvent(new StorageEvent('storage', { key: 'something_else' })); });
    expect(result.current).toBe(HERE);
  });
  it('no company in the context stays no company on every event, whatever storage holds (the alert does not clear on focus)', () => {
    store(HERE);
    const { result } = renderHook(() => useLiveActiveCompanyId(null));
    expect(result.current).toBeNull();
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(result.current).toBeNull();
    act(() => { store(ELSEWHERE); window.dispatchEvent(new StorageEvent('storage', { key: COMPANY_STORAGE_KEY })); document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBeNull();
  });
  it('the alert stays on screen after a focus when the context has no company', () => {
    store(HERE);
    function Screen() {
      const active = useLiveActiveCompanyId(null);
      return <GroupMembersSection group={group} members={members} availableCompanies={[]} activeCompanyId={active} onRefresh={vi.fn(async () => undefined)} onFlash={vi.fn()} />;
    }
    render(<Screen />);
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('a same-tab switch (the context moves) is used at once: no stale override, no extra render', () => {
    store(HERE);
    let renders = 0;
    const { result, rerender } = renderHook(({ id }: { id: string }) => { renders += 1; return useLiveActiveCompanyId(id); }, { initialProps: { id: HERE } });
    act(() => { store(ELSEWHERE); window.dispatchEvent(new Event('focus')); });
    expect(result.current).toBe(ELSEWHERE);
    renders = 0;
    rerender({ id: THIRD });                    // a same-tab switch: the context moves, and the old override (read against HERE) no longer applies
    expect(result.current).toBe(THIRD);
    expect(renders).toBe(1);                    // one render for the new props, none for syncing state
  });
  it('member rows are re-gated against the new active company without a reload', () => {
    store(HERE);
    function Screen() {
      const active = useLiveActiveCompanyId(HERE);
      return <GroupMembersSection group={group} members={members} availableCompanies={[]} activeCompanyId={active} onRefresh={vi.fn(async () => undefined)} onFlash={vi.fn()} />;
    }
    render(<Screen />);
    expect(rowOf('Here Co').querySelector('button[title="Remove"]')).toBeEnabled();
    act(() => { store(ELSEWHERE); window.dispatchEvent(new StorageEvent('storage', { key: COMPANY_STORAGE_KEY })); });
    expect(rowOf('Elsewhere Co').querySelector('button[title="Remove"]')).toBeEnabled();
    expect(rowOf('Here Co').querySelectorAll('button')[0]).toBeDisabled();
    expect(rowOf('Here Co').textContent).toContain('Switch to Here Co to change this');
  });
});
