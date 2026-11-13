/**
 * The Assumptions tab's save (budgets P6 spec §13.18): it sends the row token it read; a 409 STALE (someone
 * saved since) shows a reload prompt and Reload re-reads the row (new token, their figures), never overwriting
 * theirs; a locked version (status, or a 409 LOCKED on save) is read-only: no Save, inputs disabled. Every
 * edited field turns its chip from Derived to Manual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { assumptionsView, V1, V2 } from './fixtures';

const h = vi.hoisted(() => ({ fetchAssumptions: vi.fn(), saveAssumptionsDoc: vi.fn(), fetchChartOfAccounts: vi.fn(), fetchLoans: vi.fn(), fetchDerive: vi.fn() }));
vi.mock('@/components/accounting/budgets/threeWay/threeWayClient', () => h);

import { AssumptionsPanel } from '@/components/accounting/budgets/threeWay/AssumptionsPanel';

beforeEach(() => {
  h.fetchChartOfAccounts.mockResolvedValue({ ok: true, data: [
    { id: 'a1', accountCode: '2300', accountName: 'Income tax payable', accountType: 'liability', isActive: true, level: 3 },
    { id: 'ap', accountCode: '2000', accountName: 'Trade payables', accountType: 'liability', accountSubtype: 'payable', isActive: true, level: 3 },
    { id: 'ln', accountCode: '2500', accountName: 'Bank loan', accountType: 'liability', isActive: true, level: 3 },
  ] });
  h.fetchLoans.mockResolvedValue({ ok: true, data: [{ id: 'L1', label: 'Bank loan', glAccountId: 'ln' }] });
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

describe('a SCENARIO over a base with an invalid stored document: reset to follow the base', () => {
  const invalid = { ok: false, kind: 'invalidDoc', message: 'The assumptions document is invalid', issues: ['overrides.vat.basis.value: Invalid option'] };
  const EMPTY = { schemaVersion: 1, overrides: {} };

  it('stores EMPTY overrides (never a derived full document), no token, confirm, one retry, then re-reads', async () => {
    const onSaved = vi.fn();
    h.fetchAssumptions.mockResolvedValueOnce(invalid).mockResolvedValueOnce({ ok: true, data: assumptionsView({ updatedAt: 't8' }) });
    h.saveAssumptionsDoc
      .mockResolvedValueOnce({ ok: false, kind: 'stale', message: 'changed', currentUpdatedAt: 't7' })
      .mockResolvedValueOnce({ ok: true, data: { versionId: V1, doc: EMPTY, updatedAt: 't8', updatedBy: 'u' } });
    render(<AssumptionsPanel versionId={V1} locked={false} scenarioWithBase onSaved={onSaved} />);
    await screen.findByTestId('assumptions-invalid');
    expect(screen.queryByRole('button', { name: 'Replace with derived defaults' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to follow the base version' }));
    await screen.findByTestId('assumptions-replace-confirm');
    expect(h.fetchDerive).not.toHaveBeenCalled();
    expect(h.saveAssumptionsDoc.mock.calls[0]!.slice(1)).toEqual([EMPTY, null]);
    fireEvent.click(screen.getByRole('button', { name: 'Replace the stored document' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(h.saveAssumptionsDoc.mock.calls[1]!.slice(1)).toEqual([EMPTY, 't7']);
    await waitFor(() => expect(debtorDays().value).toBe('30'));
    expect(h.fetchAssumptions).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('assumptions-invalid')).toBeNull();
  });
});

describe('payable-account pickers', () => {
  it('offer only the accounts the server accepts: no AP, no loan account', async () => {
    h.fetchAssumptions.mockResolvedValueOnce({ ok: true, data: assumptionsView({ updatedAt: 't1' }) });
    await openPanel();
    const options = () => Array.from((screen.getByLabelText('Income tax payable account') as HTMLSelectElement).options).map((o) => o.value);
    await waitFor(() => expect(options()).toEqual(['', 'a1']));
  });

  it('a 400 naming the payable account path is shown at that picker', async () => {
    h.fetchAssumptions.mockResolvedValueOnce({ ok: true, data: assumptionsView({ updatedAt: 't1' }) });
    h.saveAssumptionsDoc.mockResolvedValueOnce({ ok: false, kind: 'invalid', message: 'The assumptions document is invalid',
      issues: ['incomeTax.payableAccountId: Must be a liability account of this company that is not a header, AP, VAT, payroll, loan or credit-card account'] });
    await openPanel();
    fireEvent.change(screen.getByLabelText('Income tax payable account'), { target: { value: 'a1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save assumptions' }));
    const issue = await screen.findByTestId('payable-issue-incomeTax');
    expect(issue.textContent).toMatch(/not a header, AP, VAT/);
    expect(screen.queryByTestId('payable-issue-dividends')).toBeNull();
  });
});

describe("a scenario whose base version's assumptions are not loaded (round 2 LOW 3)", () => {
  const scenarioView = () => {
    const v = assumptionsView();
    v.version = { ...v.version, kind: 'scenario', isPrimary: false, basedOnVersionId: V2 };
    v.chain = [V1, V2];
    return v;
  };
  const baseView = () => {
    const v = assumptionsView();
    v.version = { ...v.version, id: V2 };
    return v;
  };

  it('Save is disabled with the reason until the base loads; Retry reads it; then the save stores only the differences', async () => {
    h.fetchAssumptions.mockImplementation((id: string) => (id === V1
      ? Promise.resolve({ ok: true, data: scenarioView() })
      : Promise.resolve({ ok: false, kind: 'failed', message: 'down', status: 500 })));
    await openPanel();
    fireEvent.change(debtorDays(), { target: { value: '90' } });
    const missing = await screen.findByTestId('assumptions-base-missing');
    expect(missing.textContent).toContain("Base version's assumptions not loaded — retry");
    expect((screen.getByRole('button', { name: 'Save assumptions' }) as HTMLButtonElement).disabled).toBe(true);
    h.fetchAssumptions.mockImplementation((id: string) => Promise.resolve({ ok: true, data: id === V1 ? scenarioView() : baseView() }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('assumptions-base-missing')).toBeNull());
    expect(debtorDays().value).toBe('90');
    h.saveAssumptionsDoc.mockResolvedValueOnce({ ok: true, data: { versionId: V1, doc: {}, updatedAt: 't2', updatedBy: 'u' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save assumptions' }));
    await waitFor(() => expect(h.saveAssumptionsDoc).toHaveBeenCalled());
    expect(h.saveAssumptionsDoc.mock.calls[0]![1]).toEqual({ schemaVersion: 1, overrides: { workingCapital: { debtorDays: { value: 90, source: 'manual' } } } });
  });

  it('while the base is still loading, Save stays disabled (no silent fallback)', async () => {
    h.fetchAssumptions.mockImplementation((id: string) => (id === V1 ? Promise.resolve({ ok: true, data: scenarioView() }) : new Promise(() => undefined)));
    await openPanel();
    fireEvent.change(debtorDays(), { target: { value: '90' } });
    expect((screen.getByRole('button', { name: 'Save assumptions' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('assumptions-base-missing').textContent).toMatch(/loading/i);
  });
});
