/**
 * WhatsApp Text Command Parser — PRD-05 Phase 8
 * Pure function: parses SA informal expense shorthand into structured commands.
 */

export interface WhatsAppExpenseCommand {
  action: 'provisional_expense';
  amount: number;
  supplierHint: string | null;
  paymentMethod: 'company_card' | 'personal' | 'eft' | null;
  description: string;
}

// ─── Regex patterns ────────────────────────────────────────────────────────────

/**
 * Amount patterns (case-insensitive):
 *   R850   R1,250   R1250.50   850   1500 rand   1 500
 * Group 1 = raw number string (digits + optional comma/space separators + decimal)
 */
const AMOUNT_RE =
  /\bR\s*([\d][,\s\d]*(?:\.\d{1,2})?)\b|\b([\d][,\s\d]*(?:\.\d{1,2})?)\s*rand\b/i;

/**
 * Leading verb patterns: "paid", "spent", "bought"
 * Consumed from the front of the string to help isolate supplier hint.
 */
const VERB_RE = /^(?:paid|spent|bought)\s+/i;

/**
 * Prepositions before supplier name: "at", "from", "to"
 */
const PREP_RE = /\b(?:at|from|to)\s+/i;

/**
 * Payment method signals (in priority order):
 *   "company card" / "cc" / "business card"  → company_card
 *   "personal"                                → personal
 *   "debit" / "debit card"                   → company_card (SA context: debit ≈ bank card)
 *   "eft" / "bank transfer"                  → eft
 */
const PAYMENT_RE =
  /\b(?:(company\s+card|business\s+card|cc)|(personal)|(debit(?:\s+card)?)|(eft|bank\s+transfer))\b/i;

/**
 * Trailing noise words to strip from supplier hint.
 */
const TRAILING_NOISE_RE = /\s+(?:fuel|lunch|coffee|shop|store|supermarket|petrol|expense)s?$/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAmount(body: string): number | null {
  const match = body.match(AMOUNT_RE);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? '').replace(/[\s,]/g, '');
  const n = parseFloat(raw);
  return isFinite(n) && n > 0 ? n : null;
}

function inferPaymentMethod(
  body: string,
): 'company_card' | 'personal' | 'eft' | null {
  const match = body.match(PAYMENT_RE);
  if (!match) return null;
  if (match[1]) return 'company_card'; // company card / cc / business card
  if (match[2]) return 'personal';     // personal
  if (match[3]) return 'company_card'; // debit (SA: debit ≈ card payment)
  if (match[4]) return 'eft';          // eft / bank transfer
  return null;
}

/**
 * Extract supplier hint from the remainder after stripping:
 *  - leading verb ("paid", "spent")
 *  - the amount token
 *  - payment method token
 *  - leading prepositions ("at", "from")
 *  - punctuation noise
 *
 * Returns null when remainder is empty or only stop-words.
 */
function extractSupplierHint(body: string): string | null {
  let s = body;

  // Strip payment method phrase first (before anything else so it doesn't
  // bleed into the supplier name extraction)
  s = s.replace(PAYMENT_RE, ' ').replace(/,/g, ' ');

  // Strip verb
  s = s.replace(VERB_RE, '');

  // Strip amount token (R850, 850 rand, etc.)
  s = s.replace(AMOUNT_RE, ' ');

  // Strip leading prepositions
  s = s.replace(new RegExp('^\\s*' + PREP_RE.source, 'i'), '');

  // Strip trailing noise descriptors
  s = s.replace(TRAILING_NOISE_RE, '');

  // Collapse whitespace and strip punctuation at edges
  s = s.replace(/\s{2,}/g, ' ').trim().replace(/^[,.\-–:]+|[,.\-–:]+$/g, '').trim();

  if (!s || s.length < 2) return null;

  // Capitalise first letter for display
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse an informal WhatsApp expense shorthand body.
 *
 * Returns null when no amount is detectable or the body is pure noise.
 *
 * Examples:
 *   "paid R850 at Shell"                → amount=850, supplierHint='Shell'
 *   "spent R120 Kauai lunch"            → amount=120, supplierHint='Kauai'
 *   "R1250 Engen fuel"                  → amount=1250, supplierHint='Engen'
 *   "1500 rand Checkers"                → amount=1500, supplierHint='Checkers'
 *   "paid 850 Shell, company card"      → amount=850, paymentMethod='company_card'
 *   "paid R320 Woolworths on cc"        → paymentMethod='company_card'
 *   "R500 Pick n Pay eft"               → paymentMethod='eft'
 */
export function parseExpenseCommand(body: string): WhatsAppExpenseCommand | null {
  if (!body || !body.trim()) return null;

  const amount = parseAmount(body);
  if (amount === null) return null;

  const paymentMethod = inferPaymentMethod(body);
  const supplierHint = extractSupplierHint(body);

  return {
    action: 'provisional_expense',
    amount,
    supplierHint,
    paymentMethod,
    description: body.trim(),
  };
}
