/**
 * The Assumptions tab's save (budgets P6 spec §13.18): it sends the row token it read; a 409 STALE (someone
 * saved since) shows a reload prompt and Reload re-reads the row (new token, their figures), never overwriting
 * theirs; a locked version (status, or a 409 LOCKED on save) is read-only: no Save, inputs disabled. Every
 * edited field turns its chip from Derived to Manual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { assumptionsView, V1 } from './fixtures';

const h = vi.hoisted(() => ({ fetchAssumptions: vi.fn(), saveAssumptionsDoc: vi.fn(), fetchLiabilityAccounts: vi.fn(), fetchLoans: vi.fn() }));
vi.mock('@/components/accounting/budgets/threeWay/threeWayClient', () => h);

import { AssumptionsPanel } from '@/components/accounting/budgets/threeWay/AssumptionsPanel';

beforeEach(() => {
  h.fetchLiabilityAccounts.mockResolvedValue({ ok: true, data: [{ id: 'a1', accountCode: '2300', accountName: 'Income tax payable' }] });
  h.fetchLoans.mockResolvedValue({ ok: true, data: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); h.fetchAssumptions.mockReset(); h.saveAssumptionsDoc.mockReset(); });

const debtorDays = () => screen.getByLabelText('Debtor days') as HTMLInputElement;

async function openPanel(locked = false, onSaved = vi.fn()) {
  render(<AssumptionsPanel versionId={V1} locked={locked} onSaved={onSaved} />);
  await waitFor(() => expect(debtorDays().value).toBe('30'));
  return onSaved;
}

describe('save with the row token', () => {
  it('edits mark the field manual and the save sends the token as read', async () => {
    h.fetchAssumptions.mockResolvedValueOnce({ ok: true, data: assumptionsView({ updatedAt: 't1' }) });
    h.saveAssumptionsDoc.mockResolvedValueOnce({ ok: true, data: { versionId: V1, doc: {}, updatedAt: 't2', updatedBy: 'u' } });
    const onSaved = await openPanel();
    expect(screen.getByTestId('source-chip-workingCapital.debtorDays').textContent).toBe('Derived');
    fireEvent.change(debtorDays(), { target: { value: '60' } });
    expect(screen.getByTestId('source-chip-workingCapital.debtorDays').textContent).toBe('Manual');
    fireEvent.click(screen.getByRole('button', { name: 'Save assumptions' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [id, doc, token] = h.saveAssumptionsDoc.mock.calls[0]!;
    expect(id).toBe(V1);
    expect(token).toBe('t1');
    expect((doc as { workingCapital: { debtorDays: unknown } }).workingCapital.debtorDays).toEqual({ value: 60, source: 'manual' });
  });

  it('no stored row: the token sent is null', async () => {
    h.fetchAssumptions.mockResolvedValueOnce({ ok: true, data: assumptionsView({ updatedAt: null }) });
    h.saveAssumptionsDoc.mockResolvedValueOnce({ ok: true, data: { versionId: V1, doc: {}, updatedAt: 't2', updatedBy: 'u' } });
    await openPanel();
    fireEvent.change(debtorDays(), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save assumptions' }));
    await waitFor(() => expect(h.saveAssumptionsDoc).toHaveBeenCalled());
    expect(h.saveAssumptionsDoc.mock.calls[0]![2]).toBeNull();
  });
});

describe('409 stale → reload prompt', () => {
  it('shows the prompt, keeps the edit until Reload, then re-reads the row', async () => {
    h.fetchAssumptions
      .mockResolvedValueOnce({ ok: true, data: assumptionsView({ updatedAt: 't1' }) })
      .mockResolvedValueOnce({ ok: true, data: assumptionsView({ updatedAt: 't9', debtorDays: 75 }) });
    h.saveAssumptionsDoc.mockResolvedValueOnce({ ok: false, kind: 'stale', message: 'changed', currentUpdatedAt: 't9' });
    const onSaved = await openPanel();
    fireEvent.change(debtorDays(), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save assumptions' }));
    const prompt = await screen.findByTestId('assumptions-stale');
    expect(prompt.textContent).toMatch(/changed since you opened/i);
    expect(debtorDays().value).toBe('60');
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(debtorDays().value).toBe('75'));
    expect(h.fetchAssumptions).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('assumptions-stale')).toBeNull();
    // The next save carries the NEW token.
    h.saveAssumptionsDoc.mockResolvedValueOnce({ ok: true, data: { versionId: V1, doc: {}, updatedAt: 't10', updatedBy: 'u' } });
    fireEvent.change(debtorDays(), { target: { value: '61' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save assumptions' }));
    await waitFor(() => expect(h.saveAssumptionsDoc).toHaveBeenCalledTimes(2));
    expect(h.saveAssumptionsDoc.mock.calls[1]![2]).toBe('t9');
  });
});

describe('locked version → read-only', () => {
  it('a locked version renders no Save and disables every input', async () => {
    h.fetchAssumptions.mockResolvedValueOnce({ ok: true, data: assumptionsView({ updatedAt: 't1', status: 'locked' }) });
    await openPanel(true);
    expect(screen.queryByRole('button', { name: 'Save assumptions' })).toBeNull();
    expect(debtorDays().disabled).toBe(true);
    expect(screen.getByTestId('assumptions-readonly').textContent).toMatch(/locked/i);
  });

  it('a 409 LOCKED on save turns the form read-only', async () => {
    h.fetchAssumptions.mockResolvedValueOnce({ ok: true, data: assumptionsView({ updatedAt: 't1' }) });
    h.saveAssumptionsDoc.mockResolvedValueOnce({ ok: false, kind: 'locked', message: 'This version is locked' });
    await openPanel();
    fireEvent.change(debtorDays(), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save assumptions' }));
    await screen.findByTestId('assumptions-readonly');
    expect(debtorDays().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save assumptions' })).toBeNull();
  });
});

describe('load failure', () => {
  it('a refused read shows its message, never an empty form', async () => {
    h.fetchAssumptions.mockResolvedValueOnce({ ok: false, kind: 'forbidden', message: 'This feature is not enabled' });
    render(<AssumptionsPanel versionId={V1} locked={false} onSaved={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('This feature is not enabled');
    expect(screen.queryByLabelText('Debtor days')).toBeNull();
  });
});
