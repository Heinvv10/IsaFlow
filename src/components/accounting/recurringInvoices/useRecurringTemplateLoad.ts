/**
 * Loads one recurring-invoice template for the edit page. The editor is remounted per id, so this hook only
 * guards against a response landing after unmount; `loaded` is true once the template has been found.
 */

import { useEffect, useRef, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { LineItem } from './LineItemsSection';
import { editLines, type EditDates } from './recurringEditDates';

export interface TemplateForm {
  templateName: string;
  clientId: string;
  frequency: string;
  nextRunDate: string;
  endDate: string;
  description: string;
  taxRate: number;
  paymentTerms: string;
}

const INITIAL_FORM: TemplateForm = {
  templateName: '',
  clientId: '',
  frequency: 'monthly',
  nextRunDate: '',
  endDate: '',
  description: '',
  taxRate: 15,
  paymentTerms: '30 days',
};

export const newLine = (): LineItem => ({
  key: String(Date.now() + Math.random()),
  description: '', quantity: 1, unitPrice: 0, glAccountId: '',
});

const day = (v: unknown): string => String(v ?? '').slice(0, 10);

export function useRecurringTemplateLoad(id: string) {
  const [form, setForm] = useState<TemplateForm>(INITIAL_FORM);
  const [lines, setLines] = useState<LineItem[]>(() => [newLine()]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const loadedDates = useRef<EditDates>({ nextRunDate: '', endDate: '' });

  useEffect(() => {
    // `cancelled` guards StrictMode's double effect and unmount. It does not cover an id change: this hook
    // assumes a remount per id, so the caller must key the component by id.
    let cancelled = false;
    apiFetch('/api/accounting/recurring-invoices')
      .then(async r => { await assertOk(r, 'Could not load the recurring invoice - try again'); return r.json(); })
      .then((json: { data?: { items?: Record<string, unknown>[] } }) => {
        if (cancelled) return;
        const found = json.data?.items?.find(i => i.id === id);
        if (!found) { setLoadError('Recurring invoice not found'); return; }
        const rows = editLines(found);
        loadedDates.current = {
          nextRunDate: day(found.nextRunDate ?? found.next_run_date),
          endDate: day(found.endDate ?? found.end_date),
        };
        setForm({
          templateName: String(found.templateName ?? found.template_name ?? ''),
          clientId: String(found.clientId ?? found.client_id ?? ''),
          frequency: String(found.frequency ?? 'monthly'),
          ...loadedDates.current,
          description: String(found.description ?? ''),
          taxRate: Number(found.taxRate ?? found.tax_rate ?? 15),
          paymentTerms: String(found.paymentTerms ?? found.payment_terms ?? '30 days'),
        });
        if (rows.length > 0) setLines(rows);
        setLoaded(true);
      })
      .catch(err => {
        if (cancelled) return;
        log.error('Failed to load recurring invoice', { id, error: err }, 'recurring-edit');
        setLoadError(apiErrorMessage(err, 'Could not load the recurring invoice - try again'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  return { form, setForm, lines, setLines, loading, loaded, loadError, loadedDates };
}
