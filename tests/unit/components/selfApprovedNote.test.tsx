/** The pay-run page's note for a sole-approver self-approval: shown for that case only. */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { SelfApprovedNote } from '@/components/payroll/SelfApprovedNote';

afterEach(cleanup);

describe('SelfApprovedNote', () => {
  it('says the requester approved their own run because no one else could', () => {
    render(<SelfApprovedNote decision={{ selfApprovedSoleApprover: true, preparedByDecider: false }} />);
    const note = screen.getByTestId('self-approved-note');
    expect(note.textContent).toMatch(/person who requested the approval/);
    expect(note.textContent).toMatch(/no one else in the company could approve/);
    expect(note.textContent).not.toMatch(/also calculated/);
  });

  it('adds that the same person calculated the run', () => {
    render(<SelfApprovedNote decision={{ selfApprovedSoleApprover: true, preparedByDecider: true }} />);
    expect(screen.getByTestId('self-approved-note').textContent).toMatch(/same person also calculated this run/);
  });

  it.each([[null], [undefined], [{ selfApprovedSoleApprover: false, preparedByDecider: true }]])('renders nothing for %j', (decision) => {
    const { container } = render(<SelfApprovedNote decision={decision as never} />);
    expect(container.firstChild).toBeNull();
  });
});
