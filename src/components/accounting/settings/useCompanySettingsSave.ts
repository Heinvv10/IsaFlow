/** Company Settings Save: the company row first, then the document numbers, messages and display fields. */
import { useState } from 'react';
import { apiErrorMessage, apiFetch, ApiRequestError, assertOk } from '@/lib/apiFetch';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import type { Company, DocumentNumber } from './settingsTypes';
import { mapApiCompany } from './mapApiCompany';
import { companySavePayload } from './companySavePayload';

export interface CompanySettingsSaveInput {
  company: Company | null;
  lockdownInvalid: boolean;
  loadedMonth: number;
  setLoadedMonth: (m: number) => void;
  docNumbers: DocumentNumber[];
  messages: Record<string, string>;
  docDisplayFields: Record<string, boolean>;
  dispLoadFailed: boolean;
  companyId: string | undefined;
  refreshYearView: (companyId: string) => void;
  setError: (message: string) => void;
  /** Called once everything is stored. */
  onSaved: () => void;
}

export function useCompanySettingsSave(i: CompanySettingsSaveInput) {
  const afterDelay = useTimeoutOnce();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [stale, setStale] = useState(false); // the save found it changed since (409): offer Reload

  const handleSave = async () => {
    const { company, loadedMonth } = i;
    // Defence in depth: Save is disabled while Lockdown Date is refused, but not every path goes through the button.
    if (!company || i.lockdownInvalid) return;
    setSaving(true); i.setError(''); setStale(false); setSaved(false);
    let companySaved = false;
    try {
      const put = async (url: string, body: unknown, fallback: string) => {
        const r = await apiFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        await assertOk(r, fallback);
      };
      const r = await apiFetch('/api/accounting/companies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(companySavePayload(company, loadedMonth)) });
      await assertOk(r, 'Could not save the company details - try again');
      companySaved = true;
      const row = ((await r.json()) as { data?: Record<string, unknown> | null }).data;
      const month = row ? mapApiCompany(row).financialYearStart : company.financialYearStart; // the month now stored
      i.setLoadedMonth(month); if (month !== loadedMonth && i.companyId) i.refreshYearView(i.companyId); // periods rebuilt
      const after = 'Company details saved, but some settings could not be saved - try again';
      await Promise.all([
        i.docNumbers.length > 0 && put('/api/accounting/company-settings?type=document-numbers',
          { updates: i.docNumbers.map(d => ({ documentType: d.documentType, prefix: d.prefix, nextNumber: d.nextNumber })) }, after),
        Object.keys(i.messages).length > 0 && put('/api/accounting/company-settings?type=messages',
          { messages: Object.entries(i.messages).map(([messageType, message]) => ({ messageType, message })) }, after),
        !i.dispLoadFailed && put('/api/accounting/accounting-settings', { key: 'document_display_fields', value: JSON.stringify(i.docDisplayFields) }, after),
      ].filter(Boolean));
      i.onSaved();
      setSaved(true);
      afterDelay(() => setSaved(false), 3000);
    } catch (err) {
      setStale(!companySaved && err instanceof ApiRequestError && err.status === 409); // changed since loaded: offer Reload
      i.setError(apiErrorMessage(err, 'Could not save the changes - try again'));
    } finally {
      setSaving(false);
    }
  };

  return { handleSave, saving, saved, stale, setStale };
}
