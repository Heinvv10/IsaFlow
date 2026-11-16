/**
 * One label rule for a SARS submission's status everywhere (calendar, Recent Filings, Filings page,
 * detail modal): only IsaFlow's own ISV send that SARS accepted claims "Filed on eFiling"; an ISV
 * send SARS has not ruled on is "Sent to SARS (processing)"; a row a user recorded (no channel) is
 * "Marked submitted". Drafts, rejections and the rest keep their status name.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { statusBadge, submissionStatusBadge } from '@/components/accounting/sars/sarsStatusBadge';

const show = (node: ReturnType<typeof submissionStatusBadge>) => render(<div>{node}</div>);

describe('submissionStatusBadge', () => {
  it('ISV + accepted: Filed on eFiling', () => {
    show(submissionStatusBadge('accepted', 'isv'));
    expect(screen.getByText('Filed on eFiling')).toBeTruthy();
  });
  it('ISV + submitted: Sent to SARS (processing)', () => {
    show(submissionStatusBadge('submitted', 'isv'));
    expect(screen.getByText('Sent to SARS (processing)')).toBeTruthy();
  });
  it('no channel + submitted: Marked submitted, never eFiling', () => {
    show(submissionStatusBadge('submitted', null));
    expect(screen.getByText('Marked submitted')).toBeTruthy();
    expect(screen.queryByText(/eFiling/)).toBeNull();
  });
  it.each([['draft', 'Draft'], ['rejected', 'Rejected'], ['superseded', 'Superseded']])('%s keeps its name', (status, label) => {
    show(submissionStatusBadge(status, 'isv'));
    expect(screen.getByText(label)).toBeTruthy();
  });
  it('the plain status badge never claims eFiling for "submitted"', () => {
    render(<div>{statusBadge('submitted')}</div>);
    expect(screen.queryByText(/eFiling/)).toBeNull();
  });
});
