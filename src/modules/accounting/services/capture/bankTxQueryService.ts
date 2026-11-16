/**
 * Bank-Tx Client Query Service — Dotbiz Workstream D.
 * Creates/sends WhatsApp queries about bank transactions, lists them,
 * and manages the sent → replied → resolved | cancelled lifecycle.
 * Reply-side handling lives in bankTxQueryReplyService.ts.
 */

import { attachmentCountSql } from '../bank/bankLineDocumentSql';
import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { sendWhatsAppMessage } from './whatsAppReplyService';
import {
  composeBankTxQueryMessage,
  normalizeWhatsAppNumber,
} from './bankTxQueryMessage';

type Row = DbRow;

export interface CreateQueryInput {
  bankTransactionId: string;
  toNumber: string;
  message?: string | null;
  saveAsDefault?: boolean;
  userId: string | null;
}

export type CreateQueryResult =
  | { ok: true; query: Row }
  /** `unconfirmed`: the send's outcome is unknown; the query is recorded (status 'unconfirmed') and open. */
  | { ok: false; reason: string; unconfirmed?: true };

const UNCONFIRMED_REASON =
  'The message could not be confirmed as sent. The query is recorded as "send not confirmed" and stays open for a reply; check with the client before sending again';

function toDateString(v: Date | string): string {
  return fmtDate(v);
}

export async function createAndSendQuery(
  companyId: string,
  input: CreateQueryInput,
): Promise<CreateQueryResult> {
  const toNumber = normalizeWhatsAppNumber(input.toNumber);
  if (!toNumber) return { ok: false, reason: 'invalid whatsapp number' };

  const [tx] = (await sql`
    SELECT bt.id, bt.transaction_date, bt.description, bt.amount, bt.reference,
           c.name AS company_name
    FROM bank_transactions bt
    JOIN companies c ON c.id = bt.company_id
    WHERE bt.id = ${input.bankTransactionId}::uuid
      AND bt.company_id = ${companyId}::uuid
    LIMIT 1
  `) as Row[];
  if (!tx) return { ok: false, reason: 'bank transaction not found' };

  const body =
    input.message?.trim() ||
    composeBankTxQueryMessage({
      companyName: String(tx.company_name ?? 'your accountant'),
      txDate: toDateString(tx.transaction_date as Date | string),
      description: String(tx.description ?? ''),
      amount: Number(tx.amount ?? 0),
      reference: tx.reference == null ? null : String(tx.reference),
    }).body;

  // The query is RECORDED before the message goes out (WP7), as 'unconfirmed': only a confirmed send promotes it to
  // 'sent'. So whatever happens next, a row that exists never claims a send that was not confirmed.
  //  - a DEFINITE refusal (Twilio not configured, a 4xx validation error): the message did not go; the row is deleted;
  //  - an AMBIGUOUS failure (timeout, connection reset, 5xx, a throw): the message MAY have gone, so the row stays
  //    'unconfirmed' and open for reply matching (the client may answer it), and the caller is told (409);
  //  - a confirmed send: sid and status in one savepointed UPDATE, the default number in another, neither able to throw.
  // GUARANTEE, honestly: the row belongs to the request's transaction, which commits on a 4xx/2xx and rolls back on a
  // 5xx; a crash of the server between the send and the commit can still lose it. This closes the "insert failed after
  // a good send" gap, not that one.
  let [query] = (await sql`
    INSERT INTO bank_tx_queries (
      company_id, bank_transaction_id, to_number, message_body, status, created_by
    ) VALUES (
      ${companyId}::uuid, ${input.bankTransactionId}::uuid,
      ${toNumber}, ${body}, 'unconfirmed', ${input.userId}::uuid
    )
    RETURNING *
  `) as Row[];
  if (!query) {
    log.error('bankTxQuery: INSERT returned no row', {
      companyId, bankTransactionId: input.bankTransactionId,
    }, 'bank-tx-queries');
    return { ok: false, reason: 'internal error: query row not returned' };
  }
  const queryId = String(query.id);

  let sendResult: Awaited<ReturnType<typeof sendWhatsAppMessage>>;
  try {
    sendResult = await sendWhatsAppMessage(`whatsapp:${toNumber}`, body);
  } catch (err) {
    log.error('bankTxQuery: send threw; the query stays recorded as unconfirmed', {
      companyId, queryId, error: err instanceof Error ? err.message : String(err),
    }, 'bank-tx-queries');
    return { ok: false, unconfirmed: true, reason: UNCONFIRMED_REASON };
  }
  if (!sendResult.sent) {
    log.warn('bankTxQuery: send failed', {
      companyId, bankTransactionId: input.bankTransactionId, queryId, reason: sendResult.reason, ambiguous: sendResult.ambiguous === true,
    }, 'bank-tx-queries');
    if (sendResult.ambiguous) return { ok: false, unconfirmed: true, reason: UNCONFIRMED_REASON };
    await sql`DELETE FROM bank_tx_queries WHERE id = ${queryId}::uuid AND company_id = ${companyId}::uuid`;
    return { ok: false, reason: sendResult.reason ?? 'send failed' };
  }

  // The message is out. What follows must never undo its record: each write has its own savepoint, and a failure is
  // logged rather than thrown (a throw is a 500, which rolls the whole request back, the record included).
  try {
    await withSavepoint('bank_tx_query_confirm', async () => {
      const [confirmed] = (await sql`
        UPDATE bank_tx_queries SET status = 'sent', message_sid = ${sendResult.sid ?? null}, updated_at = NOW()
        WHERE id = ${queryId}::uuid AND company_id = ${companyId}::uuid
        RETURNING *
      `) as Row[];
      // The 201 says what the database now says: 'sent', with the sid.
      query = confirmed ?? { ...query, status: 'sent', message_sid: sendResult.sid ?? null };
    });
  } catch (err) {
    log.error('bankTxQuery: the message went out but its sid could not be saved (the query stays unconfirmed)', {
      companyId, queryId, error: err instanceof Error ? err.message : String(err),
    }, 'bank-tx-queries');
  }
  if (input.saveAsDefault) {
    try {
      await withSavepoint('bank_tx_query_default_number', async () => {
        await sql`UPDATE companies SET client_query_whatsapp = ${toNumber} WHERE id = ${companyId}::uuid`;
      });
    } catch (err) {
      log.error('bankTxQuery: the default number could not be saved', {
        companyId, queryId, error: err instanceof Error ? err.message : String(err),
      }, 'bank-tx-queries');
    }
  }

  log.info('bankTxQuery: sent', {
    companyId, bankTransactionId: input.bankTransactionId, queryId: query.id, to: toNumber,
  }, 'bank-tx-queries');

  return { ok: true, query };
}

/**
 * May a NON-admin send a query to `normalizedNumber` about this line? Only to the company's saved default number, or a
 * number that already has a thread on this very line (a follow-up). Anything else is for an owner or admin.
 */
export async function mayMessageNumber(companyId: string, bankTransactionId: string, normalizedNumber: string): Promise<boolean> {
  const [row] = (await sql`
    SELECT 1 AS ok
    WHERE EXISTS (SELECT 1 FROM companies WHERE id = ${companyId}::uuid AND client_query_whatsapp = ${normalizedNumber})
       OR EXISTS (SELECT 1 FROM bank_tx_queries WHERE company_id = ${companyId}::uuid
                    AND bank_transaction_id = ${bankTransactionId}::uuid AND to_number = ${normalizedNumber})
  `) as Row[];
  return !!row;
}

export interface ListQueryFilters {
  /** 'open' = sent or unconfirmed (nothing has resolved or cancelled it, and it has no reply yet). */
  status?: 'open' | 'sent' | 'replied' | 'resolved' | 'cancelled' | 'unconfirmed';
  bankTransactionId?: string;
}

export async function listQueries(
  companyId: string,
  filters?: ListQueryFilters,
): Promise<Row[]> {
  const status = filters?.status ?? null;
  const txId = filters?.bankTransactionId ?? null;
  return (await sql`
    SELECT q.id, q.bank_transaction_id, q.to_number, q.message_body, q.status,
           q.reply_text, q.sent_at, q.replied_at, q.resolved_at,
           bt.transaction_date, bt.description AS tx_description,
           bt.amount, bt.status AS tx_status,
           ga.account_name AS bank_account_name,
           ${sql.unsafe(attachmentCountSql('bt'))} AS attachment_count
    FROM bank_tx_queries q
    JOIN bank_transactions bt ON bt.id = q.bank_transaction_id AND bt.company_id = q.company_id
    LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id AND ga.company_id = bt.company_id
    WHERE q.company_id = ${companyId}::uuid
      AND (${status}::text IS NULL OR q.status = ${status}
           OR (${status} = 'open' AND q.status IN ('sent', 'unconfirmed')))
      AND (${txId}::uuid IS NULL OR q.bank_transaction_id = ${txId}::uuid)
    ORDER BY q.sent_at DESC
    LIMIT 200
  `) as Row[];
}

export async function setQueryStatus(
  companyId: string,
  queryId: string,
  action: 'resolve' | 'cancel',
): Promise<{ ok: boolean; reason?: string }> {
  const rows =
    action === 'resolve'
      ? ((await sql`
          UPDATE bank_tx_queries
          SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
          WHERE id = ${queryId}::uuid AND company_id = ${companyId}::uuid
            AND status IN ('sent','replied','unconfirmed')
          RETURNING id
        `) as Row[])
      : ((await sql`
          UPDATE bank_tx_queries
          SET status = 'cancelled', updated_at = NOW()
          WHERE id = ${queryId}::uuid AND company_id = ${companyId}::uuid
            AND status IN ('sent','unconfirmed')
          RETURNING id
        `) as Row[]);
  if (rows.length === 0) {
    // Distinguish "no such query" (→ 404 at the route) from "exists but the
    // action is not allowed from its current status" (→ 400).
    const [existing] = (await sql`
      SELECT status FROM bank_tx_queries
      WHERE id = ${queryId}::uuid AND company_id = ${companyId}::uuid
      LIMIT 1
    `) as Row[];
    if (!existing) return { ok: false, reason: 'not found' };
    return { ok: false, reason: `invalid state: ${String(existing.status)}` };
  }
  log.info('bankTxQuery: status changed', { companyId, queryId, action }, 'bank-tx-queries');
  return { ok: true };
}

export async function getQuerySettings(
  companyId: string,
): Promise<{ clientQueryWhatsapp: string | null; companyName: string }> {
  const [row] = (await sql`
    SELECT client_query_whatsapp, name FROM companies
    WHERE id = ${companyId}::uuid LIMIT 1
  `) as Row[];
  return {
    clientQueryWhatsapp: row?.client_query_whatsapp ? String(row.client_query_whatsapp) : null,
    companyName: row?.name ? String(row.name) : '',
  };
}

export async function saveQuerySettings(
  companyId: string,
  clientQueryWhatsapp: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  let normalized: string | null = null;
  if (clientQueryWhatsapp != null && clientQueryWhatsapp.trim() !== '') {
    normalized = normalizeWhatsAppNumber(clientQueryWhatsapp);
    if (!normalized) return { ok: false, reason: 'invalid whatsapp number' };
  }
  await sql`
    UPDATE companies SET client_query_whatsapp = ${normalized}
    WHERE id = ${companyId}::uuid
  `;
  return { ok: true };
}
