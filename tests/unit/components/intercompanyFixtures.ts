/** Wire shapes of the intercompany routes, for the component tests. */
import type { ConnectionView, GroupCandidate, SideOptions } from '@/modules/accounting/services/intercompany/connectionTypes';

export const OPTIONS: SideOptions = {
  customers: [{ id: 'cust-1', label: 'Velocity Fibre (customer)' }, { id: 'cust-2', label: 'Another customer' }],
  suppliers: [{ id: 'supp-1', label: 'Velocity Fibre (supplier)' }],
  accounts: [{ id: 'acc-1', label: '2800 Intercompany loan' }, { id: 'acc-2', label: '6100 Cost of sales' }],
  truncated: false,
};

export function connection(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: 'conn-1', kind: 'group', status: 'active', partnerCompanyId: 'co-b', partnerName: 'Velocity Fibre', invitedByCompanyId: 'co-a',
    createdAt: '2026-11-17T10:00:00.000Z', revokedAt: null,
    settings: { settlementMode: 'cash', cutoverDate: null, interestRatePct: null },
    canEditSettings: true,
    side: null,
    checklist: {
      complete: false,
      items: [
        { key: 'customer', label: 'Customer linked', required: true, done: false },
        { key: 'supplier', label: 'Supplier linked', required: true, done: false },
        { key: 'loanAccount', label: 'Loan account set', required: false, done: false },
        { key: 'cutover', label: 'Cut-over date set', required: true, done: false },
      ],
    },
    ...over,
  };
}

export const CANDIDATE: GroupCandidate = { companyId: 'co-b', companyName: 'Velocity Fibre', groupName: 'Hein group', connectionStatus: null };

export const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
export const failure = (message: string, status = 400) => new Response(JSON.stringify({ success: false, error: { message } }), { status });
