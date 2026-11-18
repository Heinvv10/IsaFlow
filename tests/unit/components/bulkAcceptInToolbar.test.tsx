/**
 * WP6 in WP4b's toolbar: the bulk-accept trigger is a pill in the toolbar row (nothing new above the table), short on
 * screen with the full name for assistive tech; ticking rows hides it (the selection bar needs the room) and never
 * remounts an open dialog.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children, href, ...r }: { children: React.ReactNode; href: string }) => <a href={href} {...r}>{children}</a> }));
vi.mock('next/router', () => ({ default: { push: vi.fn() } }));
import { apiFetch } from '@/lib/apiFetch';
import { BankTxFilters, type BankTxFiltersProps } from '@/components/accounting/bank-transactions/BankTxFilters';
import { BulkAcceptButton } from '@/components/accounting/bank-transactions/bulkAccept/BulkAcceptButton';

useApiJsonOverMock();
const preview = (n: number) => ({
  lines: Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, date: '2026-09-01', description: `L${i}`, amount: -1, glAccountId: 'g', glAccountCode: '6100', glAccountName: 'Fuel', confidence: 0.9, effectiveVatCode: 'none' })),
  totalIn: 0, totalOut: n, byAccount: [], truncated: false, scanTruncated: false, nextScanAfter: null, needsAttention: [], needsAttentionCount: 0,
  excluded: { badTarget: 0, reconciliationHeld: 0, periodClosed: 0, noPeriod: 0, vatLocked: 0, vatCode: 0 }, previewToken: 'tok',
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(apiFetch).mockImplementation(async () => ok(preview(3))); });
afterEach(cleanup);

const props = (selectedCount: number): BankTxFiltersProps => ({
  tab: 'new', page: 1, total: 40, pageSize: 25, selectedCount, selectedBank: 'b1', smartRunning: false,
  showCC: false, showBU: false, showBatchEdit: false, searchTerm: '', fromDate: '', toDate: '',
  fromAmount: '', toAmount: '', sortOrder: 'desc', allocationFilter: 'all', txType: 'all', allocType: 'all', hasSuggestion: 'all', reconFilter: 'all',
  onRefresh: vi.fn(), onBulkAccept: vi.fn(), onBatchAccept: vi.fn(), onBatchDelete: vi.fn(), onToggleBatchEdit: vi.fn(), onExport: vi.fn(),
  onExportAll: vi.fn(), onApplyRules: vi.fn(), onDownloadReport: vi.fn(), onSearchChange: vi.fn(), onFromDateChange: vi.fn(), onToDateChange: vi.fn(),
  onFromAmountChange: vi.fn(), onToAmountChange: vi.fn(), onSortOrderChange: vi.fn(), onAllocationFilterChange: vi.fn(),
  onTxTypeChange: vi.fn(), onAllocTypeChange: vi.fn(), onHasSuggestionChange: vi.fn(), onReconFilterChange: vi.fn(), onToggleCC: vi.fn(), onToggleBU: vi.fn(),
  onClearSelection: vi.fn(),
  bulkAccept: <BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} hideTrigger={selectedCount > 0} />,
});

describe('the bulk-accept trigger in the WP4b toolbar', () => {
  it('is a pill in the toolbar row, after More: "Accept 3" on screen, the full name for assistive tech', async () => {
    const { container } = render(<BankTxFilters {...props(0)} />);
    const toolbar = screen.getByTestId('bank-tx-toolbar');
    const trigger = await within(toolbar).findByRole('button', { name: 'Accept 3 high-confidence suggestions' });
    expect(trigger.parentElement).toBe(within(toolbar).getByRole('button', { name: 'Refresh' }).parentElement); // the actions row, not a row of its own
    const more = within(toolbar).getByRole('button', { name: 'More' });
    expect(more.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // after More
    const shown = Array.from(trigger.childNodes).filter((n) => !(n instanceof HTMLElement && n.classList.contains('sr-only'))).map((n) => n.textContent).join('');
    expect(shown).toBe('Accept 3');
    expect(container.firstElementChild).toBe(toolbar); // nothing added outside the toolbar
  });

  it('ticking rows hides the trigger, and an open dialog is the same node before and after', async () => {
    const { rerender } = render(<BankTxFilters {...props(0)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' }));
    await screen.findByRole('button', { name: /Confirm and post 3/ });
    const dialog = screen.getByRole('dialog');
    rerender(<BankTxFilters {...props(2)} />);
    expect(screen.queryByRole('button', { name: /high-confidence suggestion/ })).toBeNull();
    expect(screen.getByRole('dialog')).toBe(dialog);
    rerender(<BankTxFilters {...props(0)} />);
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('with rows ticked and no dialog, the trigger is not in the row (the selection bar has it)', async () => {
    render(<BankTxFilters {...props(2)} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /high-confidence suggestion/ })).toBeNull();
  });
});
