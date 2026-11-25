// Wave 7 SC (W19): the drawer does not show the official guide excerpt, even if a stale payload still carries it.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeDrawer } from '@/components/admin/payroll/SarsCodeDrawer';

afterEach(cleanup);

describe('SarsCodeDrawer', () => {
  it('does not render official_excerpt', () => {
    const code = {
      code: '4102', effective_year: 2027, category: 'deduction', description: 'Pension', status: 'active', foreign_code: null,
      code_pair: null, applicability_note: 'Applies', source_document: null, source_url: null, brs_version: '1',
      imported_at: '2026-03-01', used_by_companies: 1, official_excerpt: 'PDF BLEED',
    } as unknown as Parameters<typeof CodeDrawer>[0]['code'];
    render(<CodeDrawer code={code} onClose={() => {}} onToggleStatus={() => {}} />);
    expect(screen.getByText('Applies')).toBeTruthy();
    expect(screen.queryByText(/PDF BLEED/)).toBeNull();
    expect(screen.queryByText(/Official SARS guide excerpt/)).toBeNull();
  });
});
