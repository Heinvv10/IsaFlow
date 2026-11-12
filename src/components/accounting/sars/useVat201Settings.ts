/**
 * The active company's VAT period settings for the VAT201 page, and the from/to the
 * selector starts on (moved from pages/accounting/sars/vat201.tsx).
 */
import { useEffect, useState } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import {
  vatQuickPeriods, defaultVatQuickPeriod, normalizeVatAlignment, normalizeVatSetting,
  type VatQuickPeriod,
} from '@/modules/bureau/services/vatPeriodHelper';
import { useCompany } from '@/contexts/CompanyContext';

export function useVat201Settings(setError: (message: string) => void) {
  const { activeCompany, loading: companyLoading } = useCompany();
  const [alignment, setAlignment] = useState<'odd' | 'even'>('odd');
  const [vatPeriod, setVatPeriod] = useState<'monthly' | 'bi-monthly'>('bi-monthly');
  const [quickPeriods, setQuickPeriods] = useState<VatQuickPeriod[]>([]);
  // The selector waits for the company's VAT settings. Shown earlier it printed the
  // bi-monthly default, then flipped its label and grew a row of chips ~90ms later,
  // pushing Generate down 46px: a click at the first position hit a chip, no request.
  const [settingsReady, setSettingsReady] = useState(false);
  const defaults = defaultVatQuickPeriod(vatPeriod, alignment, new Date());
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);

  useEffect(() => {
    // The list endpoint (/api/accounting/companies) returns slim
    // { items: CompanyUser[] } rows WITHOUT VAT settings — reading them put
    // every company on the odd/bi-monthly defaults. Fetch the active
    // company's full record (?id=) instead, same as the settings page.
    if (!activeCompany?.id) {
      // No company to ask: once the context has finished loading, show the
      // selector on its defaults rather than a placeholder that never ends.
      if (!companyLoading) setSettingsReady(true);
      return;
    }
    let cancelled = false;
    setSettingsReady(false);
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/companies?id=${activeCompany.id}`, { credentials: 'include' });
        await assertOk(res, 'Could not load company VAT settings');
        const json = await res.json();
        if (cancelled || !json.data) return;
        const c = json.data as Record<string, unknown>;
        const a = normalizeVatAlignment((c.vatPeriodAlignment ?? c.vat_period_alignment) as string | undefined);
        const setting = normalizeVatSetting(
          (c.vatPeriod ?? c.vat_period) as string | undefined,
          (c.vatSystemType ?? c.vat_system_type) as string | undefined,
        );
        // Non-vendors render the notice instead; leave the period state alone.
        if (setting === 'none') { setSettingsReady(true); return; }
        const vp = setting;
        setAlignment(a); setVatPeriod(vp);
        setQuickPeriods(vatQuickPeriods(new Date().getFullYear(), vp, a));
        const def = defaultVatQuickPeriod(vp, a, new Date());
        setFrom(def.from); setTo(def.to);
        setSettingsReady(true);
      } catch {
        // Silent defaults are exactly the bug class this effect fixes — say so.
        if (!cancelled) {
          setError('Could not load company VAT settings — periods shown use the bi-monthly Category A default');
          setSettingsReady(true);
        }
      }
    })();
    return () => { cancelled = true; };
    // setError is the page's state setter (stable), so it never adds a run.
  }, [activeCompany?.id, companyLoading, setError]);

  return { alignment, vatPeriod, quickPeriods, settingsReady, from, setFrom, to, setTo };
}
