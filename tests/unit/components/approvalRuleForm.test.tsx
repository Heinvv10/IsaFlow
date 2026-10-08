/**
 * R-035 follow-up, PR A (goal §3): the Rules tab can create, edit, deactivate and
 * delete a rule. The approver roles offered are those at or below the actor's
 * rank (the role the rules GET reports, ranked on the server's own ladder); the
 * server stays authoritative, and every 4xx message it sends is shown verbatim
 * — apiFetch resolves on a 4xx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { refusal, rule, serve, type Served } from '../helpers/approvalRulesServe';
import ApprovalsPage from '@/../pages/accounting/approvals';
import { ENFORCEABLE_DOCUMENT_TYPES } from '@/modules/accounting/services/gl/approvalRuleOptions';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

afterEach(() => { cleanup(); });

async function openRules(state: Served) {
  const sent = serve(state);
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^rules$/i }));
  return sent;
}

const optionValues = (select: HTMLElement) =>
  Array.from((select as HTMLSelectElement).options).filter((o) => !o.disabled).map((o) => o.value);

async function openNewRule(state: Served) {
  const sent = await openRules(state);
  fireEvent.click(await screen.findByRole('button', { name: 'New rule' }));
  return { sent, dialog: await screen.findByRole('dialog', { name: 'New approval rule' }) };
}

describe('the approver roles offered respect the actor rank', () => {
  it('a manager is offered manager and below — never admin, owner or above', async () => {
    const { dialog } = await openNewRule({ rules: [], actorRole: 'manager' });
    const roles = optionValues(within(dialog).getByLabelText('Approver role'));
    expect(roles).toEqual(['manager', 'accountant', 'bookkeeper', 'storeman', 'technician', 'user', 'viewer']);
  });

  it('an owner is offered owner, but never super_admin', async () => {
    const { dialog } = await openNewRule({ rules: [], actorRole: 'owner' });
    const roles = optionValues(within(dialog).getByLabelText('Approver role'));
    expect(roles[0]).toBe('owner');
    expect(roles).toContain('admin');
    expect(roles).toContain('viewer');
    expect(roles).not.toContain('super_admin');
    // `system` is a pseudo-role no person holds or picks (review round 1).
    expect(roles).not.toContain('system');
  });

  it('a New rule form opens on a role the actor may choose (adversarial M16: never a fixed admin)', async () => {
    const { dialog } = await openNewRule({ rules: [], actorRole: 'manager' });
    const role = within(dialog).getByLabelText('Approver role') as HTMLSelectElement;
    expect(role.value).toBe('manager');
    expect(role.selectedOptions[0]!.disabled).toBe(false);
  });

  it('offers the enforceable document types (supplier invoices included) and no legacy type, and the three operators', async () => {
    const { dialog } = await openNewRule({ rules: [], actorRole: 'owner' });
    const types = optionValues(within(dialog).getByLabelText('Document type'));
    expect(types).toEqual([...ENFORCEABLE_DOCUMENT_TYPES]);
    for (const legacy of ['credit_note', 'payment', 'journal_entry']) expect(types).not.toContain(legacy);
    expect(optionValues(within(dialog).getByLabelText('Condition'))).toEqual(['any', 'greater_than', 'greater_equal']);
  });

  it('without a known actor role it offers no form at all', async () => {
    await openRules({ rules: [] });
    await screen.findByText('No approval rules configured');
    expect(screen.queryByRole('button', { name: 'New rule' })).toBeNull();
  });
});

describe('create', () => {
  it('posts the rule as entered and reloads the list', async () => {
    const { sent, dialog } = await openNewRule({ rules: [], actorRole: 'manager' });
    fireEvent.change(within(dialog).getByLabelText('Rule name'), { target: { value: 'Bills over 25k' } });
    fireEvent.change(within(dialog).getByLabelText('Document type'), { target: { value: 'customer_invoice' } });
    fireEvent.change(within(dialog).getByLabelText('Condition'), { target: { value: 'greater_equal' } });
    fireEvent.change(within(dialog).getByLabelText('Amount (R)'), { target: { value: '25000' } });
    fireEvent.change(within(dialog).getByLabelText('Approver role'), { target: { value: 'accountant' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' })); });
    await waitFor(() => expect(sent).toEqual([{ method: 'POST', body: {
      name: 'Bills over 25k', documentType: 'customer_invoice', conditionOperator: 'greater_equal',
      conditionValue: 25000, approverRole: 'accountant',
    } }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a 400 from the server (the legacy refusal, say) is shown verbatim in the form, which stays open', async () => {
    const message = 'Approval rules of type payment no longer govern any supplier payment. Create a supplier_payment or payment_batch rule instead.';
    const { dialog } = await openNewRule({ rules: [], actorRole: 'owner', writes: { POST: () => refusal(400, message) } });
    fireEvent.change(within(dialog).getByLabelText('Rule name'), { target: { value: 'x' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' })); });
    expect(await within(dialog).findByText(message)).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'New approval rule' })).toBeDefined();
  });
});

it('refuses an amount beyond 9 999 999 999 999.99 (numeric(15,2)) without sending it', async () => {
  const { sent, dialog } = await openNewRule({ rules: [], actorRole: 'owner' });
  fireEvent.change(within(dialog).getByLabelText('Rule name'), { target: { value: 'Huge' } });
  fireEvent.change(within(dialog).getByLabelText('Amount (R)'), { target: { value: '10000000000000' } });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' })); });
  expect(await within(dialog).findByText('Enter an amount from 0 to 9,999,999,999,999.99.')).toBeDefined();
  expect(sent).toEqual([]);
});

describe('edit', () => {
  it('opens the same form on the rule and sends a PUT with only what changed', async () => {
    const sent = await openRules({ rules: [rule()], actorRole: 'admin' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Big bills' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit approval rule' });
    expect((within(dialog).getByLabelText('Rule name') as HTMLInputElement).value).toBe('Big bills');
    expect((within(dialog).getByLabelText('Document type') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Amount (R)'), { target: { value: '60000' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' })); });
    await waitFor(() => expect(sent).toEqual([{ method: 'PUT', body: { id: 'r-1', conditionValue: 60000 } }]));
  });

  it('a 403 authority refusal is rendered verbatim', async () => {
    const message = 'Only a role above manager can lower, deactivate, delete or narrow this manager-level rule';
    await openRules({ rules: [rule()], actorRole: 'manager', writes: { PUT: () => refusal(403, message) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Big bills' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit approval rule' });
    fireEvent.change(within(dialog).getByLabelText('Amount (R)'), { target: { value: '90000' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' })); });
    expect(await within(dialog).findByText(message)).toBeDefined();
  });

  it('a rule above the actor shows its role as not selectable and leaves it out of the PUT', async () => {
    const sent = await openRules({ rules: [rule({ approverRole: 'owner' })], actorRole: 'admin' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Big bills' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit approval rule' });
    const role = within(dialog).getByLabelText('Approver role') as HTMLSelectElement;
    expect(role.value).toBe('owner');
    expect(optionValues(role)).not.toContain('owner');
    fireEvent.change(within(dialog).getByLabelText('Rule name'), { target: { value: 'Renamed' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' })); });
    await waitFor(() => expect(sent).toEqual([{ method: 'PUT', body: { id: 'r-1', name: 'Renamed' } }]));
  });
});

describe('activate / deactivate', () => {
  it('sends PUT isActive and shows a refusal verbatim', async () => {
    const message = 'Only a role above admin can lower, deactivate, delete or narrow this admin-level rule';
    const sent = await openRules({ rules: [rule({ approverRole: 'admin' })], actorRole: 'admin', writes: { PUT: () => refusal(403, message) } });
    const button = await screen.findByRole('button', { name: 'Deactivate Big bills' });
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(sent).toEqual([{ method: 'PUT', body: { id: 'r-1', isActive: false } }]));
    expect(await screen.findByText(message)).toBeDefined();
  });

  it('an inactive rule offers Activate', async () => {
    const sent = await openRules({ rules: [rule({ isActive: false })], actorRole: 'admin' });
    const button = await screen.findByRole('button', { name: 'Activate Big bills' });
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(sent).toEqual([{ method: 'PUT', body: { id: 'r-1', isActive: true } }]));
  });
});

describe('delete', () => {
  const confirmDialog = () => screen.findByRole('dialog', { name: 'Delete approval rule?' });

  it('asks first: Cancel sends nothing; confirming sends the DELETE and shows the in-use 400 verbatim', async () => {
    const message = 'This rule has approval requests recorded against it and cannot be deleted. Deactivate it instead.';
    const sent = await openRules({ rules: [rule()], actorRole: 'admin', writes: { DELETE: () => refusal(400, message) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Big bills' }));
    expect(await confirmDialog()).toHaveTextContent('Big bills');
    fireEvent.click(within(await confirmDialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Big bills' }));
    const confirm = within(await confirmDialog()).getByRole('button', { name: 'Delete rule' });
    await act(async () => { fireEvent.click(confirm); });
    expect(await screen.findByText(message)).toBeDefined();
    expect(sent.map((s) => s.method)).toEqual(['DELETE']);
  });
});
