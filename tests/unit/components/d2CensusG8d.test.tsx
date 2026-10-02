/** D2 census group 8 (d): shared components that read `res.json()` without checking the status. */
import { fireEvent, screen } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { runSiteCases } from '../helpers/d2CensusG8Harness';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true }) }));

import { ActivityTab } from '@/components/accounting/customers/ActivityTab';
import { ReportsTab } from '@/components/accounting/dashboard/ReportsTab';
import { DetailsTab } from '@/components/accounting/settings/DetailsTab';
import { DeliveryLog } from '@/components/admin/webhooks/DeliveryLog';

useApiJsonOverMock();

const PERIOD = { id: 'fp1', periodName: 'D2 Period', fiscalYear: 2026, status: 'open' };
const onError = vi.fn();
const onDocumentsChange = vi.fn();
const DOCS = [{ id: 'doc1', documentName: 'D2 cert.pdf' }];
const reported = (text: RegExp) => vi.waitFor(() => {
  expect(onError).toHaveBeenCalledWith(expect.stringMatching(text));
  expect(onError).not.toHaveBeenCalledWith(expect.stringMatching(/JSON|Unexpected end/));
});
const company = { id: 'co1' } as unknown as React.ComponentProps<typeof DetailsTab>['company'];

runSiteCases([
  { name: 'customer activity timeline', ui: () => <ActivityTab customerId="c1" />,
    hit: (u) => u.includes('customer-activities?customerId='),
    okData: [{ id: 'a1', activity_type: 'note', subject: 'D2 subject marker', description: 'D2 note', created_at: '2026-10-01T08:00:00Z',
      created_by_first_name: 'Ann', created_by_last_name: 'Lee', created_by_email: null }],
    other: () => [], plain: /Could not load activities/, okCheck: () => screen.findByText('D2 subject marker') },
  { name: 'dashboard reports: fiscal periods', ui: () => <ReportsTab />,
    hit: (u) => u.includes('fiscal-periods'), okData: [PERIOD],
    plain: /Could not load the fiscal periods/, okCheck: () => screen.findByRole('option', { name: 'D2 Period (2026)' }) },
  { name: 'dashboard reports: trial balance', ui: () => <ReportsTab />,
    hit: (u) => u.includes('reports-trial-balance'),
    okData: { rows: [{ accountCode: '9911', accountName: 'D2 TB Account', accountType: 'asset', debitBalance: 5, creditBalance: 0 }],
      totalDebit: 5, totalCredit: 5, difference: 0, balanced: true },
    other: (u) => (u.includes('fiscal-periods') ? [PERIOD] : {}), plain: /Could not load the trial balance/,
    okCheck: () => screen.findByText('D2 TB Account') },
  { name: 'company settings: document list after upload',
    ui: () => { onError.mockClear(); onDocumentsChange.mockClear();
      return <DetailsTab company={company} onChange={vi.fn()} onCompanyChange={vi.fn()} documents={[]} onDocumentsChange={onDocumentsChange} onError={onError} />; },
    hit: (u, init) => u.includes('company-documents?companyId=') && !init?.method, okData: DOCS,
    act: async () => {
      const input = document.querySelector('input[type="file"]')!;
      fireEvent.change(input, { target: { files: [new File(['x'], 'cert.pdf', { type: 'application/pdf' })] } });
    },
    see: reported, plain: /uploaded but the list could not be refreshed/,
    okCheck: () => vi.waitFor(() => expect(onDocumentsChange).toHaveBeenCalledWith(DOCS)) },
  { name: 'webhook delivery log', ui: () => <DeliveryLog webhookId="wh1" />,
    hit: (u) => u.endsWith('/api/admin/webhooks/wh1'),
    okData: { deliveries: [{ id: 'd1', success: true, deliveredAt: '2026-10-01T08:00:00Z', event: 'd2.marker', responseStatus: 200, responseBody: null }] },
    plain: /Could not load deliveries/, okCheck: () => screen.findByText('d2.marker') },
]);
