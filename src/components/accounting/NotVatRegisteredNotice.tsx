/**
 * Shown in place of a VAT surface when the active company is not a VAT vendor
 * (`companies.vat_period = 'none'`). Non-vendors must never be nudged towards
 * filing a VAT201 they do not owe, so the page renders this instead of an
 * empty form.
 */
import Link from 'next/link';
import { Info } from 'lucide-react';

export function NotVatRegisteredNotice({ surface }: { surface: string }) {
  return (
    <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-6 text-center">
      <div className="mx-auto mb-3 w-fit rounded-lg bg-teal-500/10 p-2">
        <Info className="h-6 w-6 text-teal-500" />
      </div>
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
        This company is not registered for VAT
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--ff-text-secondary)]">
        {surface} is only available to registered VAT vendors. If the company has since
        registered with SARS, set its VAT period in company settings.
      </p>
      <Link
        href="/accounting/company-settings?tab=vat"
        className="mt-4 inline-flex items-center rounded-lg border border-[var(--ff-border-light)] px-3 py-2 text-sm text-[var(--ff-text-secondary)] hover:border-teal-500/30 hover:text-[var(--ff-text-primary)]"
      >
        Open VAT settings
      </Link>
    </div>
  );
}
