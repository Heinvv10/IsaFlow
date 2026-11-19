/** Types of the intercompany inbox (P2): what the Bills "Intercompany" tab lists, and what accepting a message needs. */
import type { MirrorKind } from './mirrorPayload';

export type InboxStatus = 'pending' | 'accepted' | 'rejected' | 'dismissed' | 'failed' | 'withdrawn';
/** `open` = messages that need a person (pending, and failed ones to retry); `handled` = accepted, rejected, dismissed, withdrawn (the sender cancelled it). */
export type InboxFilter = 'open' | 'handled';

export interface InboxItem {
  id: string;
  kind: MirrorKind;
  status: InboxStatus;
  connectionId: string;
  /** From the sender's own payload: display text only, never an identity. */
  senderName: string;
  number: string;
  date: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotal: number | null;
  taxAmount: number | null;
  total: number | null;
  notes: string | null;
  creditsInvoiceNumber: string | null;
  lineCount: number;
  hasPdf: boolean;
  /** Why the message cannot be accepted as it is (unreadable payload, foreign currency); null when nothing stops it. */
  blocker: string | null;
  reason: string | null;
  error: string | null;
  /** The sender cancelled the document this message carries: a pending message is `withdrawn`, an accepted one only flagged. */
  sourceCancelled: boolean;
  /** The sender's document is no longer what the message carries (edited after it was sent). Known on the detail and on accept, not in the list. */
  sourceChanged: boolean;
  /** The auto-accept worker gave up on this message (it used every attempt): a person has to review it. */
  autoExhausted: boolean;
  handledAt: string | null;
  handledVia: 'user' | 'auto' | null;
  targetDocType: string | null;
  targetDocId: string | null;
  createdAt: string;
}

export interface InboxPage {
  items: InboxItem[];
  total: number;
  /** Messages that need a person: the badge on the Bills tab. */
  openCount: number;
}

/** A line of the message, with the expense account the receiver's draft will use for it. */
export interface InboxLine {
  index: number;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
  accountId: string | null;
  accountLabel: string | null;
  /** Where the account came from: the account last used for this description, the side's default, or nothing yet. */
  accountSource: 'last_used' | 'default' | null;
}

export interface InboxDetail {
  item: InboxItem;
  lines: InboxLine[];
  /** The supplier the draft will be on (this company's own side of the connection); null = not linked yet. */
  supplier: { id: string; name: string } | null;
  /** An existing bill / note that would make the draft a duplicate (supplier + number); null when there is none. */
  duplicateOf: { id: string; number: string } | null;
  /** Everything that stops Accept, in plain sentences; empty = Accept is possible. (A changed source is a warning on the item, not a blocker.) */
  blockers: string[];
  accounts: Array<{ id: string; label: string }>;
}

/** What the person (or nobody, for auto-accept) chose per line; absent = the suggestion stands. */
export interface AcceptInput {
  /** Line index -> GL account id, for an invoice. */
  lineAccounts?: Record<number, string>;
  /** The account a credit note credits. */
  accountId?: string;
}

export interface AcceptResult {
  messageId: string;
  targetDocType: 'supplier_invoice' | 'credit_note';
  targetDocId: string;
  linkId: string | null;
  /** False when the sender's PDF could not be copied (the draft stands without it). */
  pdfCopied: boolean;
}
