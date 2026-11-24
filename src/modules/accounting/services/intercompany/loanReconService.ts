/**
 * Intercompany loan reconciliation (P5, plan docs/plans/2026-11-24-intercompany-p5-reconciliation.md, sections (k) and (l) binding). READ
 * ONLY: it posts no journal, repairs nothing, changes no message state, takes no lock; a mismatch is state, reported, never fixed.
 *
 * ORDER (before any read of a message or ledger row): the person's own session, the dark flag `intercompany_loan_clearing` (fail closed:
 * a read error is off), the intercompany write role (loanReconRefusals.ts); then the connection must be S's and a loan connection or one
 * carrying an allocation message (else the one not_found: no existence oracle); then the 5 000 cap; then ONE statement (loanReconReads.ts)
 * under a tighten-only 15 s bound in its own savepoint (a timeout is a 503, never an empty report). The database's own rule inside b3 / b4
 * is the authority: zero rows after the app's checks passed is a not_found (fail closed). Then the pure part: each row's bucket, the
 * identities and the badge (loanReconSummary.ts), the sections and the page. The person is checked ONCE per request, here (the routes do
 * not repeat it). Strict identities (a throw on a failure) are the caller's explicit choice (the tests pass it), never read from the
 * environment.
 */
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { userCanWrite } from './allocationClearReads';
import { loanClearingEnabled } from './loanClearingGate';
import { boundStatement, countReconMessages, readReconConnections, readReconStatement, restoreStatement } from './loanReconReads';
import { firstRefusal, reconRefusal, type ParsedReconQuery } from './loanReconRefusals';
import { NO_DOCUMENTS, messageItem, sectionsOf, unlinkedItem, unsentItem, type MessageRow } from './loanReconSections';
import { summarize } from './loanReconSummary';
import {
  MAX_RECON_LIST_ROWS, MAX_RECON_MESSAGES, SECTIONS, type Direction, type MessageStatus, type PartnerDocument, type PayerState, type ReceiverState,
  type ReconConnection, type ReconItem, type ReconReport, type ReconSummary, type SectionKey, type SummaryRow,
} from './loanReconTypes';

type Row = Record<string, unknown>;

const sqlstate = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

/** The person may read the report for `companyId`, or a refusal is thrown. Nothing of a message or the ledger is read before it. */
export async function assertReconReader(companyId: string): Promise<void> {
  const session = await currentSessionActor();
  const code = firstRefusal({
    session,
    flagOn: session === 'self' && (await loanClearingEnabled(companyId)),
    canWrite: session === 'self' && (await userCanWrite(companyId)),
  });
  if (code) throw reconRefusal(code);
}

/** S's connections the report can open. */
export async function loanReconConnections(companyId: string): Promise<ReconConnection[]> {
  await assertReconReader(companyId);
  return (await readReconConnections(companyId)).map((r) => ({
    id: String(r.id), partnerName: typeof r.partner_name === 'string' ? r.partner_name : 'Another company',
    settlementMode: typeof r.settlement_mode === 'string' ? r.settlement_mode : null, status: String(r.status),
  }));
}

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const id = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function messageRow(r: Row): MessageRow {
  return {
    id: String(r.message_id), createdAt: r.created_at, ageDays: Number(r.age_days ?? 0), error: r.error,
    status: String(r.status) as MessageStatus, sourceCancelled: r.source_cancelled === true, direction: String(r.direction) as Direction,
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    payerState: text(r.payer_state) as PayerState | null, payerCounts: bool(r.payer_counts), payerLoanCredit: bool(r.payer_loan_credit),
    payerAfterT: bool(r.payer_after_t), payerJournalDiffers: bool(r.payer_journal_differs),
    receiverState: text(r.receiver_state) as ReceiverState | null, receiverCounts: bool(r.receiver_counts), receiverAfterT: bool(r.receiver_after_t),
    receiverJournalDiffers: bool(r.receiver_journal_differs), loanAccountChanged: bool(r.loan_account_changed), partnerDocument: text(r.partner_document) as PartnerDocument | null,
    display: {
      paymentNumber: text(r.d_payment_number), paymentDate: text(r.d_payment_date), reference: text(r.d_reference),
      payerDocumentNumber: text(r.d_payer_document), currency: text(r.d_currency),
    },
    own: {
      ...NO_DOCUMENTS, billId: id(r.bill_id), billNumber: text(r.bill_number), paymentId: id(r.payment_id), paymentNumber: text(r.payment_number),
      paymentStatus: text(r.payment_status), invoiceId: id(r.invoice_id), invoiceNumber: text(r.invoice_number), receiptId: id(r.receipt_id),
      receiptNumber: text(r.receipt_number),
    },
  };
}

const order = (a: ReconItem, b: ReconItem) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id);

/** A list read with one row more than the cap: at most the cap, and whether it was cut. */
export function capped(rows: Row[] | null | undefined, cap = MAX_RECON_LIST_ROWS): { rows: Row[]; truncated: boolean } {
  const all = rows ?? [];
  return { rows: all.slice(0, cap), truncated: all.length > cap };
}

export interface ReconRows { connectionId: string; partnerName: string; asOf: string; readAt: string; summary: ReconSummary; items: ReconItem[] }

/** `strict`: an identity failure throws (the tests); otherwise it is logged and counted. */
export interface ReconOptions { strict?: boolean }

/** Every row of the report, classified, and its summary: ONE statement. Checks the person first. */
export async function loadReconRows(companyId: string, connectionId: string, opts: ReconOptions = {}): Promise<ReconRows> {
  await assertReconReader(companyId);
  return readRows(companyId, connectionId, opts);
}

/** The rows, the person already checked by the caller (this module only). */
async function readRows(companyId: string, connectionId: string, opts: ReconOptions): Promise<ReconRows> {
  const conn = (await readReconConnections(companyId, connectionId))[0];
  if (!conn) throw reconRefusal('not_found');
  if ((await countReconMessages(companyId, connectionId)) > MAX_RECON_MESSAGES) throw reconRefusal('too_many');
  const row = await readOnce(companyId, connectionId);
  const summaryRow = row?.summary as SummaryRow | null | undefined;
  if (!row || !summaryRow) throw reconRefusal('not_found');

  const cutover = text(row.cutover);
  const messages = ((row.messages as Row[] | null) ?? []).map(messageRow);
  const core = summarize(summaryRow, messages, { strict: opts.strict === true });
  if (core.identityFailures > 0) {
    // a code defect, never a figure in the log
    log.error('Intercompany loan reconciliation: an identity did not hold', { companyId, connectionId, failures: core.identityFailures }, 'intercompany');
  }
  const unsent = capped(row.unsent as Row[] | null);
  const unlinked = capped(row.unlinked as Row[] | null);
  const items = [
    ...messages.map((m) => messageItem(m, cutover)),
    ...unsent.rows.map((r) => unsentItem(r, cutover)),
    ...unlinked.rows.map((r) => unlinkedItem(r, cutover)),
  ].sort(order);
  const counts = { messages: messages.length, undone: 0, attention: 0, mismatch: 0 };
  for (const it of items) for (const s of sectionsOf(it)) counts[s] += 1;
  const readAt = row.read_at instanceof Date ? row.read_at.toISOString() : new Date(String(row.read_at)).toISOString();
  return {
    connectionId, partnerName: text(conn.partner_name) ?? 'Another company', asOf: String(summaryRow.as_of).slice(0, 10), readAt,
    summary: { ...core, counts, truncated: { unsent: unsent.truncated, unlinked: unlinked.truncated } }, items,
  };
}

/** The statement under its tighten-only bound, in a savepoint of its own: a timeout leaves the request's transaction usable. */
async function readOnce(companyId: string, connectionId: string): Promise<Row | undefined> {
  try {
    return await withSavepoint('ic_loan_recon', async () => {
      const prev = await boundStatement();
      const out = await readReconStatement(companyId, connectionId);
      await restoreStatement(prev);
      return out;
    });
  } catch (err) {
    if (sqlstate(err) === '57014') {
      log.warn('Intercompany loan reconciliation timed out', { companyId, code: '57014' }, 'intercompany');
      throw reconRefusal('timeout');
    }
    throw err;
  }
}

/** One page of one section, with the whole summary (the same statement on every page). The person is checked before the request is judged
 *  (a refusal of the person comes before a bad request, (c)). */
export async function loanReconReport(companyId: string, parsed: ParsedReconQuery, opts: ReconOptions = {}): Promise<ReconReport> {
  await assertReconReader(companyId);
  if (!parsed.ok) throw reconRefusal('bad_request', parsed.error);
  const { connectionId, ...q } = parsed.value;
  const rows = await readRows(companyId, connectionId, opts);
  const key: SectionKey = SECTIONS.includes(q.section) ? q.section : 'attention';
  const listed = rows.items.filter((it) => sectionsOf(it).includes(key));
  return {
    connectionId: rows.connectionId, partnerName: rows.partnerName, asOf: rows.asOf, readAt: rows.readAt, summary: rows.summary,
    section: { key, items: listed.slice(q.offset, q.offset + q.limit), total: listed.length, limit: q.limit, offset: q.offset },
  };
}
