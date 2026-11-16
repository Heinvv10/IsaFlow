import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubmissionDetailModal, type SubmissionDetail } from '@/components/accounting/sars/SubmissionDetailModal';

const detail = (extra: Partial<SubmissionDetail>): SubmissionDetail => ({
  id: 's1', formType: 'VAT201', periodStart: '2026-01-01', periodEnd: '2026-01-31',
  status: 'submitted', formData: {}, submissionReference: 'REF-1',
  submittedAt: '2026-02-02T10:00:00Z', notes: null,
  createdAt: '2026-02-01T10:00:00Z', updatedAt: '2026-02-02T10:00:00Z', efilingChannel: null, ...extra,
});

describe('SARS filing record labels', () => {
  it('a submission a user recorded reads "Marked submitted", never eFiling', () => {
    render(<SubmissionDetailModal detail={detail({})} onClose={vi.fn()} />);
    expect(screen.getByText('Marked submitted')).toBeTruthy();
    expect(screen.getByText('Filing recorded')).toBeTruthy();
    expect(screen.queryByText('Filed on eFiling')).toBeNull();
    expect(screen.queryByText('Submitted')).toBeNull();
  });

  it('an ISV send SARS accepted reads "Filed on eFiling"', () => {
    render(<SubmissionDetailModal detail={detail({ status: 'accepted', efilingChannel: 'isv' })} onClose={vi.fn()} />);
    expect(screen.getByText('Filed on eFiling')).toBeTruthy();
  });

  it('an ISV send SARS has not ruled on reads "Sent to SARS (processing)"', () => {
    render(<SubmissionDetailModal detail={detail({ efilingChannel: 'isv' })} onClose={vi.fn()} />);
    expect(screen.getByText('Sent to SARS (processing)')).toBeTruthy();
  });
});
