/**
 * "Approve & email" on the invoice editor (master plan wave 3, PR S):
 *   1. save: the page's own (create on new; the draft PUT on edit, only if something changed);
 *   2. approve: POST customer-invoices-detail { id, action: 'approve' };
 *   3. open InvoiceEmailModal with the customer's address.
 *
 * Sending stays the user's click: the modal's Send posts to the existing /api/accounting/invoice-email, and nothing here
 * sends by itself. Closing the modal lands on the invoice, approved and unsent. A refused approval (the approval gate's
 * 409s APPROVAL_REQUIRED / APPROVAL_PENDING / APPROVAL_STALE, a journal-date or coding 400, a lock-timeout 503) goes to
 * `onRefused` with the server's sentence; the draft stays a draft. Nothing is ever retried by itself.
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/router';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

const APPROVE_FAILED = 'Could not approve the invoice - try again';
const SEND_FAILED = 'Could not send the invoice email - try again';

export interface SavedInvoice { id: string; invoiceNumber: string }

interface Options {
  /** The page's save; null when it refused (the page has shown why). */
  save: () => Promise<SavedInvoice | null>;
  /** The approval was refused; the draft stays. */
  onRefused: (invoiceId: string, message: string) => void;
  onApproved?: () => void;
}

interface EmailForm {
  invoiceId: string; invoiceNumber: string; emailTo: string; sentAt?: string; sentTo?: string;
}

interface Detail { invoice_number?: string; client_email?: string | null; email_sent_at?: string | null; email_sent_to?: string | null }

/** The approved invoice's number and the customer's address. Without them the form still opens, with the address empty. */
async function readEmailForm(saved: SavedInvoice): Promise<EmailForm> {
  const form: EmailForm = { invoiceId: saved.id, invoiceNumber: saved.invoiceNumber, emailTo: '' };
  try {
    const res = await apiFetch(`/api/accounting/customer-invoices-detail?id=${encodeURIComponent(saved.id)}`);
    await assertOk(res, 'Could not load the invoice');
    const json = await res.json() as { data?: Detail } & Detail;
    const d = json.data ?? json;
    return {
      ...form,
      invoiceNumber: d.invoice_number || saved.invoiceNumber,
      emailTo: d.client_email || d.email_sent_to || '',
      ...(d.email_sent_at ? { sentAt: d.email_sent_at } : {}),
      ...(d.email_sent_to ? { sentTo: d.email_sent_to } : {}),
    };
  } catch (err) {
    log.warn('Approve & email: could not read the customer\'s address', { invoiceId: saved.id, err }, 'useApproveAndEmail');
    return form;
  }
}

export function useApproveAndEmail({ save, onRefused, onApproved }: Options) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState<EmailForm | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');

  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await save();
      if (!saved) return;
      try {
        const res = await apiFetch('/api/accounting/customer-invoices-detail', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: saved.id, action: 'approve' }),
        });
        await assertOk(res, APPROVE_FAILED);
      } catch (err) {
        onRefused(saved.id, apiErrorMessage(err, APPROVE_FAILED));
        return;
      }
      onApproved?.();
      setResult('');
      setEmail(await readEmailForm(saved));
    } finally {
      setBusy(false);
    }
  }, [busy, save, onRefused, onApproved]);

  const send = useCallback(async () => {
    if (!email || !email.emailTo.trim() || sending) return;
    setSending(true);
    setResult('');
    try {
      const res = await apiFetch('/api/accounting/invoice-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: email.invoiceId, recipientEmail: email.emailTo.trim() }),
      });
      await assertOk(res, SEND_FAILED);
      const json = await res.json() as { data?: { sent?: boolean }; message?: string };
      setResult(json.data?.sent ? 'Invoice emailed successfully!' : (json.message || 'Email could not be sent.'));
    } catch (err) {
      setResult(apiErrorMessage(err, SEND_FAILED));
    } finally {
      setSending(false);
    }
  }, [email, sending]);

  const close = useCallback(() => {
    if (!email) return;
    const id = email.invoiceId;
    setEmail(null);
    void (async () => {
      try { await router.push(`/accounting/customer-invoices/${id}`); } catch (e) { log.warn('navigation failed', { error: e }, 'useApproveAndEmail'); }
    })();
  }, [email, router]);

  return {
    busy,
    start: () => { void start(); },
    /** InvoiceEmailModal's props while it is open, else null. */
    modal: email ? {
      open: true, invoiceNumber: email.invoiceNumber, emailTo: email.emailTo, emailSending: sending, emailSuccess: result,
      ...(email.sentAt ? { emailSentAt: email.sentAt } : {}), ...(email.sentTo ? { emailSentTo: email.sentTo } : {}),
      notice: 'Approved. Nothing is sent until you click Send Email.',
      onEmailToChange: (v: string) => setEmail((f) => (f ? { ...f, emailTo: v } : f)),
      onSend: () => { void send(); },
      onClose: close,
    } : null,
  };
}

const refusalKey = (invoiceId: string) => `isaflow:invoice-approve-refused:${invoiceId}`;

/** Carries a refused approval's sentence from the new page to the draft's edit page (never in the URL, where a link could forge it). */
export function stashApproveRefusal(invoiceId: string, message: string): void {
  try {
    sessionStorage.setItem(refusalKey(invoiceId), message);
  } catch (err) {
    log.warn('Could not carry the approval refusal to the edit page', { invoiceId, err }, 'useApproveAndEmail');
  }
}

export function takeApproveRefusal(invoiceId: string): string | null {
  try {
    const message = sessionStorage.getItem(refusalKey(invoiceId));
    if (message !== null) sessionStorage.removeItem(refusalKey(invoiceId));
    return message;
  } catch (err) {
    log.warn('Could not read the approval refusal', { invoiceId, err }, 'useApproveAndEmail');
    return null;
  }
}
