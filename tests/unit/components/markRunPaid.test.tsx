/**
 * Wave 7 MP (W27): the "Mark paid" button and dialog. Shown for an owner, admin or manager on an approved run with its
 * journal; the typed path posts the trimmed reference and the date, the file path posts nothing; a refusal stays in
 * the dialog. A paid run shows who recorded the payment, its date and how it was paid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })),
  assertOk: vi.fn(async () => undefined),
  apiErrorMessage: (e: unknown, m: string) => (e instanceof Error ? e.message : m),
}));

import { apiFetch, assertOk } from '@/lib/apiFetch';
import { MarkRunPaidButton, RunPaidNote } from '@/components/payroll/MarkRunPaid';

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());
const approved = { status: 'approved', journalEntryId: 'je-1' };

describe('MarkRunPaidButton', () => {
  it('shows for owner, admin and manager on an approved run with a journal only', () => {
    const shown = (run: { status: string; journalEntryId: string | null }, role: string) => {
      const r = render(<MarkRunPaidButton runId="r1" run={run} companyRole={role} onPaid={() => undefined} />);
      const n = screen.queryAllByRole('button', { name: /Mark paid/ }).length;
      r.unmount();
      return n;
    };
    expect(shown(approved, 'owner')).toBe(1);
    expect(shown(approved, 'admin')).toBe(1);
    expect(shown(approved, 'manager')).toBe(1);
    expect(shown(approved, 'viewer')).toBe(0);
    expect(shown({ status: 'approved', journalEntryId: null }, 'owner')).toBe(0);
    expect(shown({ status: 'paid', journalEntryId: 'je-1' }, 'owner')).toBe(0);
    expect(shown({ status: 'calculated', journalEntryId: null }, 'owner')).toBe(0);
  });

  it('typed path: needs a reference, then posts it trimmed with the date; onPaid after success', async () => {
    const onPaid = vi.fn();
    render(<MarkRunPaidButton runId="r1" run={approved} companyRole="admin" onPaid={onPaid} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark paid/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark this pay run paid?' });
    const submit = () => screen.getAllByRole('button', { name: /Mark paid/ }).find((b) => dialog.contains(b))!;
    expect(submit()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Bank payment reference/), { target: { value: '  EFT 42 ' } });
    expect(submit()).not.toBeDisabled();
    fireEvent.click(submit());
    await waitFor(() => expect(onPaid).toHaveBeenCalled());
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]!;
    expect(url).toBe('/api/payroll/runs/r1/mark-paid');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ reference: 'EFT 42', paidOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('file path posts an empty body; a refusal is shown and the dialog stays open', async () => {
    vi.mocked(assertOk).mockRejectedValueOnce(new Error('Nothing shows this run was paid'));
    const onPaid = vi.fn();
    render(<MarkRunPaidButton runId="r1" run={approved} companyRole="owner" onPaid={onPaid} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark paid/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: /salary bank file/ }));
    expect(screen.queryByLabelText(/Bank payment reference/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /Mark paid/ }).find((b) => dialog.contains(b))!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing shows this run was paid');
    expect(JSON.parse(String((vi.mocked(apiFetch).mock.calls[0]![1] as RequestInit).body))).toEqual({});
    expect(onPaid).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('RunPaidNote', () => {
  it('names the date, the reference and who recorded it; nothing for an unpaid run', () => {
    const r = render(<RunPaidNote run={{ status: 'paid', journalEntryId: 'j', paidOn: '2026-11-25', paidReference: 'EFT 42', paidByName: 'Ann Admin', paidAt: '2026-11-25T08:00:00Z' }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Paid on 25 Nov 2026 \(bank reference EFT 42\)\. Recorded by Ann Admin on 25 Nov 2026/);
    r.unmount();
    render(<RunPaidNote run={{ status: 'paid', journalEntryId: 'j', paidOn: '2026-11-25', paidReference: null }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/its confirmed salary bank file/);
    cleanup();
    // B7/Q2: a legacy paid row (no reference, no payment date) is not said to be paid by a bank file.
    render(<RunPaidNote run={{ status: 'paid', journalEntryId: 'j', paidOn: null, paidReference: null }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Paid (recorded before payment records were kept). A paid run cannot be reopened.');
    expect(screen.getByRole('status')).not.toHaveTextContent(/bank file/);
    cleanup();
    const { container } = render(<RunPaidNote run={approved} />);
    expect(container).toBeEmptyDOMElement();
  });
});
