/**
 * Bank-Tx Client Query Service — Dotbiz Workstream D.
 * Creates/sends WhatsApp queries about bank transactions, lists them,
 * and manages the sent → replied → resolved | cancelled lifecycle.
 * Reply-side handling lives in bankTxQueryReplyService.ts.
 */

import { sql } from '@/lib/neon';
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
  | { ok: false; reason: string };

function toDateString(v: Date | string): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
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

  const sendResult = await sendWhatsAppMessage(`whatsapp:${toNumber}`, body);
  if (!sendResult.sent) {
    log.warn('bankTxQuery: send failed', {
      companyId, bankTransactionId: input.bankTransactionId, reason: sendResult.reason,
    }, 'bank-tx-queries');
    return { ok: false, reason: sendResult.reason ?? 'send failed' };
  }

  const [query] = (await sql`
    INSERT INTO bank_tx_queries (
      company_id, bank_transaction_id, to_number, message_body, created_by
    ) VALUES (
      ${companyId}::uuid, ${input.bankTransactionId}::uuid,
      ${toNumber}, ${body}, ${input.userId}
    )
    RETURNING *
  `) as Row[];

  if (input.saveAsDefault) {
    await sql`
      UPDATE companies SET client_query_whatsapp = ${toNumber}
      WHERE id = ${companyId}::uuid
    `;
  }

  log.info('bankTxQuery: sent', {
    companyId, bankTransactionId: input.bankTransactionId, queryId: query?.id, to: toNumber,
  }, 'bank-tx-queries');

  return { ok: true, query: query! };
}

export interface ListQueryFilters {
  status?: 'sent' | 'replied' | 'resolved' | 'cancelled';
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
           (SELECT COUNT(*)::int FROM bank_transaction_attachments bta
             WHERE bta.bank_transaction_id = q.bank_transaction_id) AS attachment_count
    FROM bank_tx_queries q
    JOIN bank_transactions bt ON bt.id = q.bank_transaction_id
    LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
    WHERE q.company_id = ${companyId}::uuid
      AND (${status}::text IS NULL OR q.status = ${status})
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
            AND status IN ('sent','replied')
          RETURNING id
        `) as Row[])
      : ((await sql`
          UPDATE bank_tx_queries
          SET status = 'cancelled', updated_at = NOW()
          WHERE id = ${queryId}::uuid AND company_id = ${companyId}::uuid
            AND status = 'sent'
          RETURNING id
        `) as Row[]);
  if (rows.length === 0) return { ok: false, reason: 'query not found or invalid state' };
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
