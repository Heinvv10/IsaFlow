/**
 * The whole of `/accounting/reports/report-packs?print=1`.
 *
 * A component rather than a branch inside the page: the page's default export
 * has to stay a dispatcher that calls one hook, and this half owns its own
 * data hook.
 *
 * No AppLayout — the chrome is hidden by print.css anyway, and its sidebar,
 * setup-guide and preferences fetches are gone.
 *
 * _app.tsx used to fire three more regardless: /api/auth/me,
 * /api/accounting/companies and /api/track/event, from the app-level
 * providers and the analytics tracker. Under the Playwright transport those
 * were merely stubbed; under Gotenberg, which cannot intercept, /api/auth/me
 * CLEARED the cookie carrying the print token. All three are now gated off a
 * print render (see printRenderQuery.ts and the tests in
 * tests/unit/components/packs/appPrint*.dom.test.tsx), so this page fetches
 * exactly the two paths its print token authorises and nothing else.
 */
import { PackPrintView } from './PackPrintView';
import { usePackPrintData } from './usePackPrintData';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

export interface PackPrintPageProps {
  packType: PackType;
  from: string;
  to: string;
}

export function PackPrintPage({ packType, from, to }: PackPrintPageProps) {
  const { document, error } = usePackPrintData(packType, from, to);

  // Never print-ready: the renderer times out loudly rather than photographing
  // a pack with a hole in it. The text is here for a human who opens the same
  // URL in a browser and needs to know why nothing rendered.
  if (error) {
    return <p className="p-8 text-sm text-[var(--ff-text-secondary)]">This pack could not be built: {error}</p>;
  }

  return <PackPrintView document={document} />;
}
