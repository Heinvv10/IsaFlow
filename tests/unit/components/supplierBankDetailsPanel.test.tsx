/**
 * Supplier bank verification (forensic-controls step 1), the UI: the supplier
 * page's "Bank details" panel and the switch row in ApprovalEnforcementPanel.
 * The panel shows the derived state, offers Verify only when the server says
 * the viewer may, sends back the fingerprint it was SHOWN with, reloads
 * whichever way the verify went (apiFetch resolves on a 4xx, so a refusal must
 * be said, not swallowed), and treats a body without the expected shape as a
 * failure rather than rendering it.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { SupplierBankDetailsPanel } from '@/components/accounting/suppliers/SupplierBankDetailsPanel';
import { ApprovalEnforcementPanel } from '@/components/accounting/approvals/ApprovalEnforcementPanel';

const notifyError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify: { error: (m: string) => notifyError(m), success: vi.fn() } }));
useApiJsonOverMock();
afterEach(() => { cleanup(); notifyError.mockReset(); });

const S = '11111111-1111-4111-8111-111111111111';
const FP = 'a'.repeat(64);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const bank = { bankName: 'FNB', maskedAccount: '•••• 7777', branchCode: '250655', accountType: 'current', holder: 'Karoo' };
const view = (over: Record<string, unknown> = {}) => ({
  supplierId: S, enforced: true, state: 'unverified', fingerprint: FP, bank, verifierRole: 'admin', canVerify: true,
  latest: { kind: 'baseline', method: null, note: null, verifiedBy: 'u1', verifiedByName: 'Bongi', verifiedAt: '2026-10-07T23:30:00Z' },
  history: [], ...over,
});

/** GET answers each view in turn (the last repeats); POST answers `post`. */
function serve(views: unknown[], post: () => Response = () => json({ success: true, data: { kind: 'verified' } })) {
  let n = 0;
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') return post();
    return json({ success: true, data: views[Math.min(n++, views.length - 1)] });
  });
}
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) }));
const gets = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => !init?.method).length;

it('unverified and permitted: Verify needs a note, sends the shown fingerprint, method and trimmed note, then shows the reload', async () => {
  serve([view(), view({ state: 'verified', canVerify: false,
    latest: { kind: 'verified', method: 'in_person', note: 'met them', verifiedBy: 'u2', verifiedByName: 'Cara', verifiedAt: '2026-10-08T10:00:00Z' } })]);
  render(<SupplierBankDetailsPanel supplierId={S} />);
  expect(await screen.findByText('Unverified — changed since last verified')).toBeDefined();
  const button = screen.getByRole('button', { name: /verify bank details/i });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/how did you confirm/i), { target: { value: 'in_person' } });
  fireEvent.change(screen.getByLabelText(/^note/i), { target: { value: '  met them  ' } });
  expect(button).not.toBeDisabled();
  fireEvent.click(button);
  expect(await screen.findByText('Verified')).toBeDefined();
  expect(posts()).toEqual([{ url: '/api/accounting/supplier-bank-verification',
    body: { supplierId: S, fingerprint: FP, method: 'in_person', note: 'met them' } }]);
  expect(screen.queryByRole('button', { name: /verify bank details/i })).toBeNull();
});

it('a refused verify (409) is said, the panel reloads, and the button is released', async () => {
  serve([view()], () => json({ success: false, error: { message: 'These bank details changed after you opened them.' } }, 409));
  render(<SupplierBankDetailsPanel supplierId={S} />);
  fireEvent.change(await screen.findByLabelText(/^note/i), { target: { value: 'called' } });
  fireEvent.click(screen.getByRole('button', { name: /verify bank details/i }));
  await waitFor(() => expect(notifyError).toHaveBeenCalledWith('These bank details changed after you opened them.'));
  await waitFor(() => expect(gets()).toBe(2));
  await waitFor(() => expect(screen.getByRole('button', { name: /verify bank details/i })).not.toBeDisabled());
});

it('not permitted, never verified: says so and offers no form', async () => {
  serve([view({ canVerify: false, latest: null })]);
  render(<SupplierBankDetailsPanel supplierId={S} />);
  expect(await screen.findByText('Unverified — not verified yet')).toBeDefined();
  expect(screen.getByText(/you cannot verify these details here/i)).toBeDefined();
  expect(screen.queryByRole('button', { name: /verify bank details/i })).toBeNull();
});

it('verified: shows who and the South African date of the verification, not the UTC one', async () => {
  serve([view({ state: 'verified', canVerify: false })]);
  render(<SupplierBankDetailsPanel supplierId={S} />);
  expect(await screen.findByText(/accepted when verification was switched on by Bongi on 08 Oct 2026/i)).toBeDefined();
});

it('control off: "Not applicable", and where to switch it on', async () => {
  serve([view({ state: 'not_enforced', enforced: false, canVerify: false, latest: null })]);
  render(<SupplierBankDetailsPanel supplierId={S} />);
  expect(await screen.findByText('Not applicable')).toBeDefined();
  expect(screen.getByText(/verification is off for this company/i)).toBeDefined();
});

it('a body without the expected shape is an error message, not a crash', async () => {
  serve([{ id: S, name: 'Karoo' }]);
  render(<SupplierBankDetailsPanel supplierId={S} />);
  expect(await screen.findByText('Could not load the bank details - try again')).toBeDefined();
});

it('the switch row: off shows the baseline count, and switching on posts supplier_bank_details', async () => {
  let on = false;
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') { on = JSON.parse(String(init.body)).enabled; return json({ success: true, data: {} }); }
    return json({ data: { items: on ? [{ documentType: 'supplier_bank_details' }] : [], enforceable: ['supplier_bank_details'],
      preview: { supplier_bank_details: on ? 0 : 4 } } });
  });
  render(<ApprovalEnforcementPanel />);
  const toggle = await screen.findByRole('checkbox', { name: /require independent verification of supplier bank details/i });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText('4 suppliers would be accepted as verified')).toBeDefined();
  expect(screen.getByText(/switching on again accepts nothing/i)).toBeDefined();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(posts().map((p) => p.body)).toEqual([{ documentType: 'supplier_bank_details', enabled: true }]);
  expect(screen.getByText('0 suppliers unverified')).toBeDefined();
});
