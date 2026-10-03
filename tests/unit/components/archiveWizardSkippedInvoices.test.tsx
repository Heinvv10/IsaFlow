/**
 * R-186: the archive preview says how many customer invoices cannot be archived because a
 * Paystack or Stitch payment request refers to them, and that any journal of theirs before the
 * cutoff refuses the whole archive (it must not read as "the rest goes ahead"). Nothing when 0.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ArchiveWizardSection } from '@/components/accounting/ArchiveWizardSection';
import type { ArchivePreview } from '@/modules/accounting/services/core/dataArchivingService';

afterEach(cleanup);

function renderWith(preview: ArchivePreview) {
  const noop = () => undefined;
  render(
    <ArchiveWizardSection cutoffDate="2005-01-01" maxCutoff="2021-10-03" validation={null} validating={false}
      preview={preview} previewing={false} onCutoffChange={noop} onValidate={noop} onPreview={noop} />,
  );
}

const base: ArchivePreview = {
  journalEntries: 0, journalLines: 0, bankTransactions: 0, customerInvoices: 1,
  customerInvoicesSkipped: 0, supplierInvoices: 0, totalRecords: 1,
};

describe('ArchiveWizardSection: gateway-skipped invoices', () => {
  it('names the skipped count', () => {
    renderWith({ ...base, customerInvoicesSkipped: 2 });
    expect(screen.getByText(new RegExp('^2 paid or cancelled customer invoice\\(s\\) before the cutoff cannot be archived: '
      + 'a Paystack or Stitch payment request refers to them\\.\\s+If any of them has a journal before the cutoff, '
      + 'the whole archive is refused; Validate reports it\\.$'))).toBeTruthy();
  });

  it('says nothing when none are skipped', () => {
    renderWith(base);
    expect(screen.queryByText(/payment request/)).toBeNull();
  });
});
