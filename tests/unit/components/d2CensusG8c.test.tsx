/** D2 census group 8 (c): GL import (validate + import), time tracking (entries + summary) and the webhook list. */
import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { runSiteCases } from '../helpers/d2CensusG8Harness';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/webhooks/ConfirmDeleteModal', () => ({ ConfirmDeleteModal: () => null }));
vi.mock('@/components/admin/webhooks/WebhookRow', () => ({ WebhookRow: ({ wh }: { wh: { url: string } }) => <tr><td>{wh.url}</td></tr> }));
vi.mock('@/components/accounting/time-tracking/TimeEntryModal', () => ({ TimeEntryModal: () => null }));
vi.mock('@/components/accounting/time-tracking/TimeFilters', () => ({ TimeFilters: () => null, SummaryDateFilter: () => null }));
vi.mock('@/components/accounting/time-tracking/BulkActionsBar', () => ({ BulkActionsBar: () => null }));
vi.mock('@/components/accounting/time-tracking/TimeEntriesTable', () => ({
  TimeEntriesTable: ({ entries }: { entries: { taskDescription: string }[] }) => <div>{entries.map(e => e.taskDescription).join(',')}</div> }));
vi.mock('@/components/accounting/time-tracking/TimeSummaryTab', () => ({
  TimeSummaryTab: ({ summary }: { summary: { byProject: { projectName: string }[] } | null }) => <div>{summary?.byProject[0]?.projectName}</div> }));
vi.mock('exceljs', () => {
  const rows = [['Date', 'Account Code', 'Description', 'Debit', 'Credit'], ['2026-10-01', '1000', 'D2 line', '5', '0']];
  class Workbook {
    xlsx = { load: async () => undefined };
    worksheets = [{ eachRow: (_o: unknown, cb: (r: { values: unknown[] }) => void) => rows.forEach(r => cb({ values: [undefined, ...r] })) }];
  }
  return { default: { Workbook } };
});

import GlImportPage from '../../../pages/accounting/gl-import';
import TimeTrackingPage from '../../../pages/accounting/time-tracking/index';
import AdminWebhooksPage from '../../../pages/admin/webhooks';

useApiJsonOverMock();

const SUMMARY = { validations: [{ valid: true, warnings: [] }], validCount: 1, warningCount: 0, errorCount: 0, isBalanced: true, totalDebit: 5, totalCredit: 5 };
const upload = async () => {
  const input = await vi.waitFor(() => { const i = document.querySelector('input[type="file"]'); if (!i) throw new Error('no input'); return i; });
  fireEvent.change(input, { target: { files: [new File(['x'], 'ledger.xlsx')] } });
};
const validate = async () => { await upload(); fireEvent.click(await screen.findByRole('button', { name: /^Validate$/ })); };

runSiteCases([
  { name: 'gl import: validate', ui: () => <GlImportPage />,
    hit: (u) => u.includes('gl-import-validate'), okData: SUMMARY, act: validate,
    plain: /Validation failed/, okCheck: () => screen.findByRole('button', { name: /Continue \(1 valid rows\)/ }) },
  { name: 'gl import: import', ui: () => <GlImportPage />,
    hit: (u) => u.endsWith('/api/accounting/gl-import'), okData: { entriesCreated: 3, linesCreated: 6, totalValue: 5 }, other: () => SUMMARY,
    act: async () => {
      await validate();
      fireEvent.click(await screen.findByRole('button', { name: /Continue \(1 valid rows\)/ }));
      fireEvent.click(await screen.findByRole('button', { name: /Import 1 rows/ }));
    },
    plain: /Import failed/, okCheck: () => screen.findByText('Import Successful') },
  { name: 'time tracking: entries', ui: () => <TimeTrackingPage />,
    hit: (u) => u.includes('time-entries?'), okData: { entries: [{ id: 'e1', taskDescription: 'D2 task marker' }], total: 1 },
    plain: /Could not load time entries/, okCheck: () => screen.findByText('D2 task marker') },
  { name: 'time tracking: summary', ui: () => <TimeTrackingPage />,
    hit: (u) => u.includes('time-summary'), okData: { byProject: [{ projectName: 'D2 project marker', hours: 1, value: 2 }] },
    act: async () => { fireEvent.click(await screen.findByRole('button', { name: 'Summary' })); },
    plain: /Could not load the summary/, okCheck: () => screen.findByText('D2 project marker') },
  { name: 'admin webhooks', ui: () => <AdminWebhooksPage />,
    hit: (u) => u.includes('/api/admin/webhooks?'), okData: { items: [{ id: 'w1', url: 'https://d2.example/hook', failureCount: 0 }], total: 1 },
    plain: /Could not load webhooks/, okCheck: () => screen.findByText('https://d2.example/hook') },
]);
