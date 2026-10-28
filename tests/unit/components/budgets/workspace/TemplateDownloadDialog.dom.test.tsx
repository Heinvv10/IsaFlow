import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TemplateDownloadDialog, type TemplateDownloadDialogProps } from '@/components/accounting/budgets/workspace/TemplateDownloadDialog';
import * as client from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';

vi.mock('@/components/accounting/budgets/workspace/budgetWorkspaceClient');

const CC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CC_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const member = (id: string, code: string) => ({ id, code, name: `Name ${code}`, isActive: true });
const props = (over: Partial<TemplateDownloadDialogProps> = {}): TemplateDownloadDialogProps => ({
  open: true, onClose: vi.fn(), versionId: 'v1', fiscalYear: 2027,
  dimensions: { cc1: [member(CC_A, 'A'), member(CC_B, 'B'), member(CC_C, 'C')], cc2: [], bu: [] },
  cells: [{ glAccountId: 'x', cc1Id: CC_A, cc2Id: null, buId: null, month: '2027-01', amount: 5 }], ...over,
});

beforeEach(() => {
  vi.mocked(client.fetchPriorActuals).mockReset().mockResolvedValue({
    ok: true, data: { fiscalYear: 2027, grain: 'cc1', months: [], priorMonths: [], cells: [{ glAccountId: 'x', dimensionId: CC_B, month: '2027-01', amount: 1 }] },
  });
  vi.mocked(client.downloadTemplate).mockReset().mockResolvedValue({ ok: true, data: { blob: new Blob(['x']), fileName: 'budget.xlsx' } });
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
});
afterEach(cleanup);

it('downloads the company grain without members', async () => {
  const p = props();
  render(<TemplateDownloadDialog {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(client.downloadTemplate).toHaveBeenCalledWith('v1', 'company', undefined));
  await waitFor(() => expect(p.onClose).toHaveBeenCalled());
});

it('ticks members with amounts or prior-year activity by default and sends exactly the ticked members', async () => {
  render(<TemplateDownloadDialog {...props()} />);
  fireEvent.change(screen.getByLabelText('Rows per'), { target: { value: 'cc1' } });
  await waitFor(() => expect((screen.getByLabelText(/Name B/) as HTMLInputElement).checked).toBe(true));
  expect((screen.getByLabelText(/Name A/) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText(/Name C/) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText(/Name C/));
  fireEvent.click(screen.getByLabelText(/Name A/));
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(client.downloadTemplate).toHaveBeenCalledWith('v1', 'cc1', [CC_B, CC_C]));
});

it('shows the server refusal to pick fewer members and stays open', async () => {
  vi.mocked(client.downloadTemplate).mockResolvedValue({ ok: false, kind: 'invalid', message: 'Too many rows: pick fewer members.', code: null });
  const p = props();
  render(<TemplateDownloadDialog {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/pick fewer members/);
  expect(p.onClose).not.toHaveBeenCalled();
});
