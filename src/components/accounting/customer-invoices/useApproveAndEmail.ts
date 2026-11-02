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
import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { ApiRequestError, apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { approvalShown, type ShownForApproval } from './approveShown';

const APPROVE_FAILED = 'Could not approve the invoice - try again';
const SEND_FAILED = 'Could not send the invoice email - try again';
const OPEN_FAILED = 'Could not open the invoice - it is approved; find it in the invoice list.';
const APPROVED = 'Approved. Nothing is sent until you click Send Email.';
const DRIFTED = 'The invoice changed while it was being approved: that change was not saved and is not on the approved invoice.';

export interface SavedInvoice { id: string; invoiceNumber: string }

interface Options {
  /** The page's save; null when it refused (the page has shown why). */
  save: () => Promise<SavedInvoice | null>;
  /**
   * The approval was refused; the draft stays. `status`: its HTTP status (409: the approval gate, or STALE_VIEW);
   * `reason`: the refusal's reason code, when the server gave one.
   */
  onRefused: (invoiceId: string, message: string, status?: number, reason?: string) => void;
  onApproved?: () => void;
  /** The form as it would be saved, now. Compared after the approval: a change that landed meanwhile is not on it. */
  bodyNow: () => string | null;
  /** The invoice on screen when Approve & email is clicked: sent with the approval, which a different stored one refuses (409 STALE_VIEW). */
  shown: ShownForApproval;
}

interface EmailForm {
  invoiceId: string; invoiceNumber: string; emailTo: string; sentAt?: string; sentTo?: string;
}

interface Detail { invoice_number?: string; client_email?: string | null; email_sent_at?: string | null; email_sent_to?: string | null }

/** A refusal's reason code (`error.details.reason`), read from a copy so assertOk still reads the body. */
async function refusalReason(res: Response): Promise<string | undefined> {
  if (res.ok) return undefined;
  try {
    const body = await res.clone().json() as { error?: { details?: { reason?: unknown } } };
    return typeof body.error?.details?.reason === 'string' ? body.error.details.reason : undefined;
  } catch {
    return undefined; // not JSON: assertOk gives the fallback sentence, and there is no reason to act on
  }
}

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

export function useApproveAndEmail({ save, onRefused, onApproved, bodyNow, shown }: Options) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState<EmailForm | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');
  const [sent, setSent] = useState(false);
  const sentNow = useRef(false);
  const run = useRef(0); // each Approve & email; a dismissal moves it on, so an answer for the old one is ignored // read when a navigation fails, after the render that knew about the send
  const markSent = (v: boolean) => { sentNow.current = v; setSent(v); };
  const [drifted, setDrifted] = useState(false);

  const start = useCallback(async () => {
    if (busy) return;
    const mine = ++run.current;
    const current = () => mine === run.current;
    setBusy(true);
    try {
      const approvedBody = bodyNow(); // before the save: a change typed while it is out is not on the approved invoice
      const shownNow = approvalShown(shown);
      let reason: string | undefined;
      const saved = await save();
      if (!saved || !current()) return;
      try {
        const res = await apiFetch('/api/accounting/customer-invoices-detail', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: saved.id, action: 'approve', ...shownNow }),
        });
        if (!res.ok) reason = await refusalReason(res);
        await assertOk(res, APPROVE_FAILED);
      } catch (err) {
        if (!current()) return;
        onRefused(saved.id, apiErrorMessage(err, APPROVE_FAILED), err instanceof ApiRequestError ? err.status : undefined, reason);
        return;
      }
      if (!current()) return;
      onApproved?.();
      setDrifted(bodyNow() !== approvedBody);
      setResult('');
      markSent(false);
      const form = await readEmailForm(saved);
      if (current()) setEmail(form);
    } finally {
      if (current()) setBusy(false);
    }
  }, [busy, save, onRefused, onApproved, bodyNow, shown]);

  const send = useCallback(async () => {
    if (!email || !email.emailTo.trim() || sending || sent) return;
    setSending(true);
    setResult('');
    try {
      const res = await apiFetch('/api/accounting/invoice-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: email.invoiceId, recipientEmail: email.emailTo.trim() }),
      });
      await assertOk(res, SEND_FAILED);
      const json = await res.json() as { data?: { sent?: boolean }; message?: string };
      markSent(Boolean(json.data?.sent));
      setResult(json.data?.sent ? 'Invoice emailed successfully!' : (json.message || 'Email could not be sent.'));
    } catch (err) {
      setResult(apiErrorMessage(err, SEND_FAILED));
    } finally {
      setSending(false);
    }
  }, [email, sending, sent]);

  const close = useCallback(() => {
    if (!email || sending) return;
    const id = email.invoiceId;
    // The form goes only once the invoice is open: behind it, the editor is not the page to be left on.
    void (async () => {
      let opened = false;
      try { opened = (await router.push(`/accounting/customer-invoices/${id}`)) === true; } catch (e) { log.warn('navigation failed', { error: e }, 'useApproveAndEmail'); }
      if (opened) setEmail(null);
      else setResult((r) => (sentNow.current ? `${r} ${OPEN_FAILED}` : OPEN_FAILED)); // once sent, it still says so
    })();
  }, [email, sending, router]);

  /** Drops the email form without navigating (the page was opened again in place). */
  const dismiss = useCallback(() => {
    run.current++;
    setBusy(false); setEmail(null); setResult(''); sentNow.current = false; setSent(false);
  }, []);

  return {
    busy,
    dismiss,
    start: () => { void start(); },
    /** InvoiceEmailModal's props while it is open, else null. */
    modal: email ? {
      open: true, invoiceNumber: email.invoiceNumber, emailTo: email.emailTo, emailSending: sending, emailSuccess: result,
      ...(email.sentAt ? { emailSentAt: email.sentAt } : {}), ...(email.sentTo ? { emailSentTo: email.sentTo } : {}),
      notice: drifted ? `${APPROVED} ${DRIFTED}` : APPROVED,
      onEmailToChange: (v: string) => setEmail((f) => (f ? { ...f, emailTo: v } : f)),
      onSend: () => { void send(); },
      onClose: close,
    } : null,
  };
}

const refusalKey = (invoiceId: string) => `isaflow:invoice-approve-refused:${invoiceId}`;

/** Carries a refused approval's sentence from the new page to the draft's edit page (never in the URL, where a link could forge it). */
export function stashApproveRefusal(invoiceId: string, message: string, status?: number): void {
  try {
    sessionStorage.setItem(refusalKey(invoiceId), JSON.stringify({ message, status: status ?? null }));
  } catch (err) {
    log.warn('Could not carry the approval refusal to the edit page', { invoiceId, err }, 'useApproveAndEmail');
  }
}

/** The refusal carried from the new page, with its HTTP status (409: the approval gate, which stays on screen). */
export function takeApproveRefusal(invoiceId: string): { message: string; status: number | null } | null {
  try {
    const raw = sessionStorage.getItem(refusalKey(invoiceId));
    if (raw === null) return null;
    sessionStorage.removeItem(refusalKey(invoiceId));
    const { message, status } = JSON.parse(raw) as { message?: unknown; status?: unknown };
    return typeof message === 'string' ? { message, status: typeof status === 'number' ? status : null } : null;
  } catch (err) {
    log.warn('Could not read the approval refusal', { invoiceId, err }, 'useApproveAndEmail');
    return null;
  }
}
