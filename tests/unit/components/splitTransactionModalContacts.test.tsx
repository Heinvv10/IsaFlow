/**
 * The bank screen's Split Transaction modal: a line may be a GL account, a
 * supplier or a customer. A supplier/customer line posts as a contact line
 * (contactType + contactId, optionally autoApply 'none') and offers no VAT
 * and no project/BU, because the server refuses them on a settlement. An
 * account line still posts as before. Amounts go out as whole cents.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { SplitTransactionModal } from '@/components/accounting/SplitTransactionModal';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
useApiJsonOverMock();

const TX = { id: 'bt-1', description: 'Frik Basson', amount: -1959.48, transactionDate: '2026-10-07' };
const GL = [{ id: 'gl-fuel', name: 'Fuel', code: '6100' }];
const SUPPLIERS = [{ id: 'sup-frik', name: 'Tech - Frik Basson' }, { id: 'sup-se', name: 'Southern Elements' }];
const CUSTOMERS = [{ id: 'cus-1', name: 'Acme' }];
const CC2 = [{ id: 'cc2-1', name: 'Lawley', code: 'LAW' }];

const posts: unknown[] = [];
beforeEach(() => {
  posts.length = 0;
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ success: true, data: { journalEntryId: 'je-1' } }));
  });
});
afterEach(cleanup);

function renderModal() {
  const onSplit = vi.fn();
  render(<SplitTransactionModal transaction={TX as never} glAccounts={GL} suppliers={SUPPLIERS} customers={CUSTOMERS}
    cc2Options={CC2} onClose={vi.fn()} onSplit={onSplit} />);
  return onSplit;
}
const pick = (lineButtonText: string, optionName: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: lineButtonText }));
  fireEvent.click(screen.getByRole('button', { name: optionName }));
};

it('a supplier line offers suppliers, hides VAT and project, and posts as a contact line', async () => {
  const onSplit = renderModal();
  fireEvent.change(screen.getByLabelText('Line 1 type'), { target: { value: 'supplier' } });
  expect(screen.queryByLabelText('Line 1 VAT')).toBeNull();
  expect(screen.queryByLabelText('Line 1 project')).toBeNull();
  fireEvent.change(screen.getByLabelText('Line 1 amount'), { target: { value: '800' } });
  pick('Select supplier', 'Tech - Frik Basson');

  fireEvent.click(screen.getByRole('button', { name: /add line/i }));
  fireEvent.change(screen.getByLabelText('Line 2 type'), { target: { value: 'supplier' } });
  fireEvent.change(screen.getByLabelText('Line 2 amount'), { target: { value: '1159.48' } });
  pick('Select supplier', 'Southern Elements');
  fireEvent.click(screen.getAllByLabelText(/Leave on account/)[1]!);

  fireEvent.click(screen.getByRole('button', { name: 'Split & Allocate' }));
  await waitFor(() => expect(onSplit).toHaveBeenCalled());
  expect(posts[0]).toEqual({
    action: 'split_allocate', bankTransactionId: 'bt-1',
    lines: [
      { amount: 800, contactType: 'supplier', contactId: 'sup-frik' },
      { amount: 1159.48, contactType: 'supplier', contactId: 'sup-se', autoApply: 'none' },
    ],
  });
});

it('an account line still posts its account, VAT and project; a customer line offers customers', async () => {
  const onSplit = renderModal();
  fireEvent.change(screen.getByLabelText('Line 1 amount'), { target: { value: '1000' } });
  pick('Select GL Account', /Fuel/);
  fireEvent.change(screen.getByLabelText('Line 1 VAT'), { target: { value: 'standard' } });
  fireEvent.change(screen.getByLabelText('Line 1 project'), { target: { value: 'cc2-1' } });

  fireEvent.click(screen.getByRole('button', { name: /add line/i }));
  fireEvent.change(screen.getByLabelText('Line 2 type'), { target: { value: 'customer' } });
  expect(screen.queryByRole('button', { name: 'Southern Elements' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Line 2 amount'), { target: { value: '959.475' } }); // rounds to cents
  pick('Select customer', 'Acme');

  fireEvent.click(screen.getByRole('button', { name: 'Split & Allocate' }));
  await waitFor(() => expect(onSplit).toHaveBeenCalled());
  expect((posts[0] as { lines: unknown[] }).lines).toEqual([
    { amount: 1000, contraAccountId: 'gl-fuel', vatCode: 'standard', cc2Id: 'cc2-1' },
    { amount: 959.48, contactType: 'customer', contactId: 'cus-1' },
  ]);
});

it('changing a line\'s type clears what it had picked, so Split stays disabled until it is picked again', () => {
  renderModal();
  fireEvent.change(screen.getByLabelText('Line 1 amount'), { target: { value: '1959.48' } });
  pick('Select GL Account', /Fuel/);
  expect(screen.getByRole('button', { name: 'Split & Allocate' })).not.toBeDisabled();
  fireEvent.change(screen.getByLabelText('Line 1 type'), { target: { value: 'supplier' } });
  expect(screen.getByRole('button', { name: 'Select supplier' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Split & Allocate' })).toBeDisabled();
});

it('an account line with VAT and a project, switched to a supplier, posts none of them', async () => {
  const onSplit = renderModal();
  fireEvent.change(screen.getByLabelText('Line 1 amount'), { target: { value: '1959.48' } });
  pick('Select GL Account', /Fuel/);
  fireEvent.change(screen.getByLabelText('Line 1 VAT'), { target: { value: 'standard' } });
  fireEvent.change(screen.getByLabelText('Line 1 project'), { target: { value: 'cc2-1' } });
  fireEvent.click(screen.getByRole('button', { name: /6100 Fuel/ }));
  expect(screen.getByLabelText('Line 1 search accounts')).toBeInTheDocument(); // picker open
  fireEvent.change(screen.getByLabelText('Line 1 type'), { target: { value: 'supplier' } });
  expect(screen.queryByLabelText(/Line 1 search/)).toBeNull(); // the change closed it
  pick('Select supplier', 'Southern Elements');
  fireEvent.click(screen.getByRole('button', { name: 'Split & Allocate' }));
  await waitFor(() => expect(onSplit).toHaveBeenCalled());
  expect((posts[0] as { lines: unknown[] }).lines).toEqual([{ amount: 1959.48, contactType: 'supplier', contactId: 'sup-se' }]);
});

