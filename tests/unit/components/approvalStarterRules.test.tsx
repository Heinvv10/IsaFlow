/**
 * R-035 follow-up, PR A (goal §3, Hein 2026-10-08 §2a.2): "Start from
 * recommended rules". Offered while the company lacks an active rule for at
 * least one type in the set; previews the set with a tick box, an editable
 * amount and an approver role (at or below the actor's rank) per row; confirms
 * the ticked rows in one POST and then shows what was created and skipped.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { json, refusal, rule, serve, type Served } from '../helpers/approvalRulesServe';
import ApprovalsPage from '@/../pages/accounting/approvals';
import { STARTER_RULES } from '@/modules/accounting/services/gl/approvalStarterRules';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

afterEach(() => { cleanup(); });

const START = 'Start from recommended rules';

async function openRules(state: Served) {
  const sent = serve(state);
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^rules$/i }));
  return sent;
}

async function openPreview(state: Served) {
  const sent = await openRules(state);
  fireEvent.click(await screen.findByRole('button', { name: START }));
  return { sent, region: await screen.findByRole('region', { name: 'Recommended rules' }) };
}

const allActive = () => STARTER_RULES.map((r, i) => rule({ id: `s${i}`, name: r.name, documentType: r.documentType }));

describe('when it is offered', () => {
  it('is offered while some type in the set has no active rule', async () => {
    await openRules({ rules: allActive().slice(1), actorRole: 'owner' });
    expect(await screen.findByRole('button', { name: START })).toBeDefined();
  });

  it('is not offered once every type has an active rule; an inactive rule does not count', async () => {
    await openRules({ rules: allActive(), actorRole: 'owner' });
    await screen.findByText(STARTER_RULES[0]!.name, { selector: 'td' });
    expect(screen.queryByRole('button', { name: START })).toBeNull();
    cleanup();
    await openRules({ rules: allActive().map((r, i) => (i === 0 ? { ...r, isActive: false } : r)), actorRole: 'owner' });
    expect(await screen.findByRole('button', { name: START })).toBeDefined();
  });
});

describe('the preview', () => {
  it('lists the seven recommended rules with their amounts and approvers, a rule already active unticked', async () => {
    const { region } = await openPreview({ rules: [rule({ name: 'Large payments', documentType: 'payment_batch' })], actorRole: 'owner' });
    const boxes = within(region).getAllByRole('checkbox');
    expect(boxes).toHaveLength(7);
    expect(within(region).getByRole('checkbox', { name: 'Include Payment Batch: Large payments' })).not.toBeChecked();
    expect(within(region).getByRole('checkbox', { name: 'Include Supplier Invoice: Large supplier invoices' })).toBeChecked();
    expect((within(region).getByLabelText('Amount for Supplier Payment') as HTMLInputElement).value).toBe('100000');
    expect((within(region).getByLabelText('Approver for Supplier Payment') as HTMLSelectElement).value).toBe('admin');
    // "All journal entries" matches every journal: no amount to edit.
    expect(within(region).queryByLabelText('Amount for Manual Journal')).toBeNull();
  });

  it("offers only roles at or below the actor's; a row whose approver is above it starts unticked with that role not selectable", async () => {
    const { region } = await openPreview({ rules: [], actorRole: 'manager' });
    const role = within(region).getByLabelText('Approver for Supplier Payment') as HTMLSelectElement;
    expect(role.value).toBe('admin');
    const selectable = Array.from(role.options).filter((o) => !o.disabled).map((o) => o.value);
    expect(selectable).not.toContain('admin');
    expect(selectable[0]).toBe('manager');
    expect(within(region).getByRole('checkbox', { name: 'Include Supplier Payment: Large payments' })).not.toBeChecked();
    expect(within(region).getByRole('checkbox', { name: 'Include Supplier Invoice: Large supplier invoices' })).toBeChecked();
  });

  it('confirms exactly the ticked rows with the amounts and roles changed, then shows created and skipped', async () => {
    const created = (body: unknown) => {
      const rows = (body as { rules: { documentType: string }[] }).rules;
      return json({ success: true, data: {
        created: rows.slice(1).map((r, i) => rule({ id: `c${i}`, documentType: r.documentType, name: `Created ${r.documentType}` })),
        skipped: [{ documentType: rows[0]!.documentType, name: 'Large supplier invoices' }],
      } });
    };
    const { sent, region } = await openPreview({ rules: [], actorRole: 'owner', writes: { POST: created } });
    for (const name of ['Customer Invoice: Large customer invoices', 'Customer Credit Note: Credit notes over R10k',
      'Supplier Credit Note: Credit notes over R10k', 'Payment Batch: Large payments']) {
      fireEvent.click(within(region).getByRole('checkbox', { name: `Include ${name}` }));
    }
    fireEvent.change(within(region).getByLabelText('Amount for Supplier Invoice'), { target: { value: '75000' } });
    fireEvent.change(within(region).getByLabelText('Approver for Supplier Payment'), { target: { value: 'owner' } });
    await act(async () => { fireEvent.click(within(region).getByRole('button', { name: 'Create selected rules' })); });

    await waitFor(() => expect(sent).toEqual([{ method: 'POST', body: { action: 'starter', rules: [
      { documentType: 'supplier_invoice', conditionValue: 75000, approverRole: 'manager' },
      { documentType: 'supplier_payment', conditionValue: 100000, approverRole: 'owner' },
      { documentType: 'manual_journal', approverRole: 'accountant' },
    ] } }]));
    expect(await within(region).findByText('Created 2 rules')).toBeDefined();
    expect(within(region).getByText(/Created supplier_payment/)).toBeDefined();
    expect(within(region).getByText(/Skipped 1 already active/)).toBeDefined();
    expect(within(region).getByText(/Large supplier invoices/)).toBeDefined();
  });

  it('a refusal is shown verbatim and nothing is reported as created', async () => {
    const message = 'This rule requires the admin role; you do not hold it, so you cannot create, change or delete it';
    const { region } = await openPreview({ rules: [], actorRole: 'manager', writes: { POST: () => refusal(403, message) } });
    fireEvent.click(within(region).getByRole('checkbox', { name: 'Include Supplier Payment: Large payments' }));
    await act(async () => { fireEvent.click(within(region).getByRole('button', { name: 'Create selected rules' })); });
    expect(await within(region).findByText(message)).toBeDefined();
    expect(within(region).queryByText(/^Created/)).toBeNull();
  });

  it('refuses to send an amount that is not a number, or one beyond the column', async () => {
    const { sent, region } = await openPreview({ rules: [], actorRole: 'owner' });
    for (const value of ['', '10000000000000']) {
      fireEvent.change(within(region).getByLabelText('Amount for Supplier Invoice'), { target: { value } });
      await act(async () => { fireEvent.click(within(region).getByRole('button', { name: 'Create selected rules' })); });
      expect(await within(region).findByText('Enter an amount from 0 to 9,999,999,999,999.99 for Supplier Invoice.')).toBeDefined();
    }
    expect(sent).toEqual([]);
  });
});
