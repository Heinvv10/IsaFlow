/**
 * Bank-Tx Client Query — pure message helpers (Dotbiz Workstream D).
 * No DB, no clock: fully unit-testable.
 */

export interface BankTxQueryTemplateInput {
  companyName: string;
  txDate: string;       // YYYY-MM-DD
  description: string;
  amount: number;       // signed rand value as stored on bank_transactions
  reference?: string | null;
}

const MAX_DESC = 120;

/** Compose the freeform WhatsApp query message (≤ ~500 chars, text-only). */
export function composeBankTxQueryMessage(
  input: BankTxQueryTemplateInput,
): { body: string } {
  const { companyName, txDate, description, amount, reference } = input;

  const date = new Date(`${txDate}T00:00:00Z`).toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const desc = description.trim().slice(0, MAX_DESC) || 'no description';

  // Normalize non-breaking and narrow-no-break spaces to plain space so
  // the assertion `R1 234,56` passes regardless of ICU group-separator char.
  const amt = Math.abs(amount)
    .toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/ | /g, ' ');

  const ref = reference?.trim() ? ` (ref ${reference.trim().slice(0, 40)})` : '';

  const body =
    `Hi, this is the accounting team for ${companyName}. ` +
    `Please help us identify this bank transaction: ` +
    `${date} — "${desc}" — R${amt}${ref}. ` +
    `Reply with a short note on what it was for, or send a photo of the slip or invoice.`;

  return { body };
}

/**
 * Normalise a WhatsApp destination to bare E.164 (+27821234567).
 * Accepts 'whatsapp:+27...', '+27 82 123-4567', '0821234567' (SA local).
 * Returns null when the input cannot be normalised safely.
 */
export function normalizeWhatsAppNumber(raw: string): string | null {
  const stripped = raw.replace(/^whatsapp:/i, '').replace(/[\s().\-]/g, '');
  if (/^\+\d{8,15}$/.test(stripped)) return stripped;
  if (/^0\d{9}$/.test(stripped)) return `+27${stripped.slice(1)}`;
  return null;
}
