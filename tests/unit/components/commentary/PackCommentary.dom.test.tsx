/**
 * The REAL `PackCommentary` (what the report-packs page mounts) lists every
 * draft of the pack. It used to mount the panel with `sectionRef="commentary"`
 * while `generateDrafts` files rows under `income_statement` / `balance_sheet`,
 * so the internal list filtered every draft out: nothing to edit or approve.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));

import { PackCommentary } from '@/components/accounting/packs/PackOwnerTools';

const row = (over: Partial<CommentaryRow>): CommentaryRow => ({
  id: 'r', sectionRef: 'income_statement', rowRef: 'revenue', draftText: 'Revenue up.', approvedText: null,
  status: 'draft', approvedBy: null, approvedAt: null, withdrawnBy: null, withdrawnAt: null, ...over,
});
const rows = [
  row({ id: 'a', rowRef: 'revenue', draftText: 'Revenue rose 17%.' }),
  row({ id: 'b', rowRef: 'netProfit', draftText: 'Net profit doubled.' }),
  row({ id: 'c', sectionRef: 'balance_sheet', rowRef: 'liquidity', draftText: 'Liquidity is thin.' }),
  row({ id: 'd', rowRef: 'costs', status: 'rejected', draftText: 'REJECTED ONE' }),
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ success: true, data: { commentary: rows } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('PackCommentary', () => {
  it('lists every draft of the pack with Approve and Edit, grouped under a labelled section', async () => {
    render(<PackCommentary params={{ type: 'board', from: '2026-03-01', to: '2026-08-31' }} />);
    await waitFor(() => expect(screen.getByText('Revenue rose 17%.')).toBeTruthy());
    expect(screen.getByText('Net profit doubled.')).toBeTruthy();
    expect(screen.getByText('Liquidity is thin.')).toBeTruthy();
    expect(screen.queryByText('REJECTED ONE')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /^Edit:/ })).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Income statement' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Balance sheet' })).toBeTruthy();
  });
});
