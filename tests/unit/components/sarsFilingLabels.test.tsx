import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubmissionDetailModal } from '@/components/accounting/sars/SubmissionDetailModal';

describe('SARS filing record labels', () => {
  it('labels a submitted status and timestamp as a filing recorded on eFiling', () => {
    render(
      <SubmissionDetailModal
        detail={{
          id: 's1', formType: 'VAT201', periodStart: '2026-01-01', periodEnd: '2026-01-31',
          status: 'submitted', formData: {}, submissionReference: 'REF-1',
          submittedAt: '2026-02-02T10:00:00Z', notes: null,
          createdAt: '2026-02-01T10:00:00Z', updatedAt: '2026-02-02T10:00:00Z',
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Filed on eFiling')).toBeTruthy();
    expect(screen.getByText('Filing recorded')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
  });
});
