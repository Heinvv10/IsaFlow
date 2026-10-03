/**
 * R-186: the archive preview says how many customer invoices stay live because a
 * Paystack payment request refers to them, and says nothing when there are none.
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

describe('ArchiveWizardSection: Paystack-skipped invoices', () => {
  it('names the skipped count', () => {
    renderWith({ ...base, customerInvoicesSkipped: 2 });
    expect(screen.getByText(/^2 paid or cancelled customer invoice\(s\) before the cutoff\s+stay live: a Paystack payment request refers to them\.$/)).toBeTruthy();
  });

  it('says nothing when none are skipped', () => {
    renderWith(base);
    expect(screen.queryByText(/Paystack payment request/)).toBeNull();
  });
});
