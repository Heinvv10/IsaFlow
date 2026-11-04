/**
 * Budgets P5-3 review r2 (blind LOWs 4 and 6):
 *   - the PO actions are offered only to roles that may use them: Approve to owner / admin / manager (`canWrite`),
 *     Cancel order to owner / admin (`canCancelApprovedPo`), each the route's own gate; Cancel posts the reason.
 *   - the PO line editor keys rows by a stable per-row key: removing a middle row leaves the other rows' DOM in
 *     place (focus stays in the row being edited) with their own dimensions.
 * Mutation check: key the rows by index, or show Approve to a viewer / Cancel to a manager, and a test goes red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const role = vi.hoisted(() => ({ value: 'owner' as string }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ companyRole: role.value, activeCompany: { id: 'c1' } }), useCompanyRoleOrNull: () => role.value,
}));

import { apiFetch } from '@/lib/apiFetch';
import { PurchaseOrderApproveButton } from '@/components/accounting/purchase-orders/PurchaseOrderApproveButton';
import { PurchaseOrderCancelButton } from '@/components/accounting/purchase-orders/PurchaseOrderCancelButton';
import { PoLineItemsEditor, type PoEditLine } from '@/components/accounting/purchase-orders/PoLineItemsEditor';

const PO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const LISTS: Record<string, unknown> = {
  'cc_type=cc1': { items: [{ id: 'ft', code: 'FT', name: 'Fibertime' }, { id: 'ht', code: 'HT', name: 'Hometech' }, { id: 'vf', code: 'VF', name: 'Velocity' }] },
  'cc_type=cc2': { items: [] },
  'business-units': { items: [] },
};

useApiJsonOverMock();
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => {
    const u = String(url);
    const list = Object.entries(LISTS).find(([k]) => u.includes(k));
    if (list) return ok(list[1]);
    if (u.endsWith('/cancel')) return ok({ id: PO, status: 'cancelled' });
    throw new Error(`unexpected ${u}`);
  });
});
afterEach(() => { cleanup(); role.value = 'owner'; });

describe('PO actions by role', () => {
  const approve = () => render(<PurchaseOrderApproveButton poId={PO} onApproved={vi.fn()} onError={vi.fn()} onReload={async () => {}} />);
  const cancel = (onCancelled = vi.fn()) => { render(<PurchaseOrderCancelButton poId={PO} onCancelled={onCancelled} />); return onCancelled; };

  it('Approve: shown to owner, admin and manager; hidden from a viewer', () => {
    for (const r of ['owner', 'admin', 'manager']) {
      role.value = r;
      approve();
      expect(screen.queryByRole('button', { name: 'Approve' }), r).not.toBeNull();
      cleanup();
    }
    role.value = 'viewer';
    approve();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('Cancel order: shown to owner and admin; hidden from a manager and a viewer', () => {
    for (const [r, shown] of [['owner', true], ['admin', true], ['manager', false], ['viewer', false]] as const) {
      role.value = r;
      cancel();
      expect(screen.queryByRole('button', { name: 'Cancel order' }) !== null, r).toBe(shown);
      cleanup();
    }
  });

  it('Cancel order asks a reason and posts it', async () => {
    const onCancelled = cancel();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Cancel order' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: ' Supplier withdrew ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
    const call = vi.mocked(apiFetch).mock.calls.find(([u]) => String(u).endsWith('/cancel'))!;
    expect(String(call[0])).toBe(`/api/accounting/purchase-orders/${PO}/cancel`);
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ reason: 'Supplier withdrew' });
  });
});

describe('PoLineItemsEditor rows', () => {
  const line = (key: string, description: string, cc1: string): PoEditLine => ({
    key, description, quantity: '1', unit_price: '10', tax_rate: '15', gl_account_id: '', product_id: '', cc1_id: cc1, cc2_id: '', bu_id: '',
  });
  function Harness() {
    const [items, setItems] = useState<PoEditLine[]>([line('k1', 'First', 'ft'), line('k2', 'Second', 'ht'), line('k3', 'Third', 'vf')]);
    return (
      <PoLineItemsEditor items={items} accounts={[]} storedLabels={{}} onAdd={() => {}}
        onRemove={(i) => setItems((xs) => xs.filter((_, j) => j !== i))}
        onUpdate={(i, field, v) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, [field]: v } : x)))} />
    );
  }

  it('removing a middle row keeps the other rows (their DOM, focus and dimensions)', async () => {
    render(<Harness />);
    expect(await screen.findAllByRole('option', { name: 'VF Velocity' })).toHaveLength(3);
    const third = screen.getByRole('textbox', { name: 'Line 3 description' }) as HTMLInputElement;
    third.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(screen.queryByDisplayValue('Second')).toBeNull();
    expect(document.activeElement).toBe(third); // the same input, still mounted and focused
    expect(third.value).toBe('Third');
    expect((screen.getByRole('combobox', { name: 'Line 1 CC1' }) as HTMLSelectElement).value).toBe('ft');
    expect((screen.getByRole('combobox', { name: 'Line 2 CC1' }) as HTMLSelectElement).value).toBe('vf');
  });
});
