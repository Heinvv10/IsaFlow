/**
 * The Assumptions tab's save (budgets P6 spec §13.18): it sends the row token it read; a 409 STALE (someone
 * saved since) shows a reload prompt and Reload re-reads the row (new token, their figures), never overwriting
 * theirs; a locked version (status, or a 409 LOCKED on save) is read-only: no Save, inputs disabled. Every
 * edited field turns its chip from Derived to Manual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { assumptionsView, V1 } from './fixtures';

const h = vi.hoisted(() => ({ fetchAssumptions: vi.fn(), saveAssumptionsDoc: vi.fn(), fetchLiabilityAccounts: vi.fn(), fetchLoans: vi.fn(), fetchDerive: vi.fn() }));
vi.mock('@/components/accounting/budgets/threeWay/threeWayClient', () => h);

import { AssumptionsPanel } from '@/components/accounting/budgets/threeWay/AssumptionsPanel';

beforeEach(() => {
  h.fetchLiabilityAccounts.mockResolvedValue({ ok: true, data: [{ id: 'a1', accountCode: '2300', accountName: 'Income tax payable' }] });
  h.fetchLoans.mockResolvedValue({ ok: true, data: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); h.fetchAssumptions.mockReset(); h.saveAssumptionsDoc.mockReset(); h.fetchDerive.mockReset(); });

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

describe('a stored document that no longer validates (400 BUDGET_ASSUMPTIONS_INVALID on read)', () => {
  const invalid = { ok: false, kind: 'invalidDoc', message: 'The assumptions document is invalid', issues: ['workingCapital.debtorDays.value: Too big'] };
  const derive = () => {
    const v = assumptionsView();
    return { ok: true, data: { version: v.version, assumptions: v.derived.assumptions, evidence: v.derived.evidence } };
  };
  const saved = { ok: true, data: { versionId: V1, doc: {}, updatedAt: 't8', updatedBy: 'u' } };

  async function replaceWithDerived(onSaved = vi.fn()) {
    h.fetchAssumptions.mockResolvedValueOnce(invalid);
    h.fetchDerive.mockResolvedValueOnce(derive());
    render(<AssumptionsPanel versionId={V1} locked={false} onSaved={onSaved} />);
    const alert = await screen.findByTestId('assumptions-invalid');
    expect(alert.textContent).toContain('workingCapital.debtorDays.value: Too big');
    expect(screen.queryByLabelText('Debtor days')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace with derived defaults' }));
    await waitFor(() => expect(debtorDays().value).toBe('30'));
    expect(h.fetchDerive).toHaveBeenCalledWith(V1);
    return onSaved;
  }

  it('shows the issues, loads the derived defaults, saves with no token, then retries ONCE with the server token after confirming', async () => {
    const onSaved = await replaceWithDerived();
    const save = screen.getByRole('button', { name: 'Save assumptions' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false); // nothing edited, but the replacement itself is the change
    h.saveAssumptionsDoc
      .mockResolvedValueOnce({ ok: false, kind: 'stale', message: 'changed', currentUpdatedAt: 't7' })
      .mockResolvedValueOnce(saved);
    fireEvent.click(save);
    const confirm = await screen.findByTestId('assumptions-replace-confirm');
    expect(confirm.textContent).toMatch(/replace/i);
    expect(h.saveAssumptionsDoc).toHaveBeenCalledTimes(1);
    expect(h.saveAssumptionsDoc.mock.calls[0]![2]).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace the stored document' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(h.saveAssumptionsDoc).toHaveBeenCalledTimes(2);
    expect(h.saveAssumptionsDoc.mock.calls[1]![2]).toBe('t7');
    expect((h.saveAssumptionsDoc.mock.calls[1]![1] as { schemaVersion: number }).schemaVersion).toBe(1);
    expect(screen.queryByTestId('assumptions-invalid')).toBeNull();
  });

  it('a second 409 after the confirmed retry is the ordinary reload prompt, never a third save', async () => {
    await replaceWithDerived();
    h.saveAssumptionsDoc
      .mockResolvedValueOnce({ ok: false, kind: 'stale', message: 'changed', currentUpdatedAt: 't7' })
      .mockResolvedValueOnce({ ok: false, kind: 'stale', message: 'changed again', currentUpdatedAt: 't9' });
    fireEvent.click(screen.getByRole('button', { name: 'Save assumptions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace the stored document' }));
    await screen.findByTestId('assumptions-stale');
    expect(h.saveAssumptionsDoc).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('assumptions-replace-confirm')).toBeNull();
  });

  it('a locked version cannot be replaced', async () => {
    h.fetchAssumptions.mockResolvedValueOnce(invalid);
    render(<AssumptionsPanel versionId={V1} locked onSaved={vi.fn()} />);
    await screen.findByTestId('assumptions-invalid');
    expect(screen.queryByRole('button', { name: 'Replace with derived defaults' })).toBeNull();
  });

  it('a refused derive shows its message', async () => {
    h.fetchAssumptions.mockResolvedValueOnce(invalid);
    h.fetchDerive.mockResolvedValueOnce({ ok: false, kind: 'forbidden', message: 'No write access' });
    render(<AssumptionsPanel versionId={V1} locked={false} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace with derived defaults' }));
    await waitFor(() => expect(screen.getByTestId('assumptions-invalid').textContent).toContain('No write access'));
  });
});
