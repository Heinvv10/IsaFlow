/**
 * Portal Chatbot API
 * POST: client asks a question, gets AI-powered response
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { classifyClientQuery, buildClientChatPrompt, parseClientChatResponse, sanitizeClientResponse, type ClientContext } from '@/modules/accounting/services/ar/portalChatbotService';
import { resolvePortalSession } from '@/modules/accounting/services/ar/portalSession';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { getClientOverdue } from '@/modules/accounting/services/ar/portalOverdue';
import { fmtDate } from '@/lib/fmtDate';

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const session = await resolvePortalSession(req);
  if (!session) {
    return res.status(401).json({ success: false, error: { message: 'Not authenticated' } });
  }
  const sessionClientId = session.clientId;
  const sessionCompanyId = session.companyId;

  // Rate limit: 20 requests per 15 minutes per IP (calls Claude API) PLUS a per-company
  // daily cap so one tenant's portal customers can't collectively exhaust the AI budget
  // across many IPs (pentest H8 — portal chat had no per-company/daily bound).
  const ip = getClientIp(req);
  if (!(await checkRateLimit(`portal-chat:${ip}`, { max: 20, windowSecs: 15 * 60 }))) {
    return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } });
  }
  if (!(await checkRateLimit(`portal-chat:co:${sessionCompanyId}:day`, { max: 500, windowSecs: 86_400 }))) {
    return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Daily AI request limit reached. Please try again tomorrow.' } });
  }

  const { question, clientId } = req.body;
  if (!question) return apiResponse.badRequest(res, 'question is required');
  if (!clientId || clientId !== sessionClientId) return apiResponse.badRequest(res, 'clientId mismatch or missing');
  if (question.length > 500) return apiResponse.badRequest(res, 'question too long (max 500 chars)');

  const queryType = classifyClientQuery(question);

  // Build client context from DB — all queries scoped to session company_id.
  //
  // R-095 M2: this used to select `amount, customer_id` from customer_payments
  // (neither column exists — the table has `total_amount` and `client_id`
  // only) so the route 500'd on every call, and quoted a balance via a bare
  // `status NOT IN ('cancelled', 'draft', 'paid')` — unrouted through R-082's
  // shared population rule, so it admitted pending_approval and silently
  // dropped a NULL-status invoice. outstandingBalance is now sourced from
  // fetchStatementData — the SAME service the portal statement and the
  // emailed statement use — so the chatbot cannot quote a different balance
  // than the statement the customer can also open. Overdue/open-invoice
  // count is routed through documentInPopulationExpr and tests the ACTUAL
  // outstanding amount (total - paid > 0) rather than a hand-rolled 'paid'
  // status exclusion. The overdue figure is derived from the statement's
  // closing balance (portalOverdue — R-095 round 4), never summed from
  // invoice balances, which ignore unallocated receipts and credit notes.
  const asOf = asAtTodayStr();
  const [clients, invoiceCount, lastPay, statementData] = await Promise.all([
    sql`SELECT name FROM customers WHERE id = ${clientId} AND company_id = ${sessionCompanyId}::UUID LIMIT 1` as Promise<Row[]>,
    // K-053: the portal quotes the customer a balance, so it asks the same
    // dated soft-delete question the ageing and the control account ask.
    sql`SELECT COUNT(*) as cnt FROM customer_invoices ci WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId} AND ci.company_id = ${sessionCompanyId}::UUID AND ${documentInLedgerAsAtFragment('ci', asOf, sessionCompanyId)} AND ${sql.unsafe(documentInPopulationExpr('ci'))} AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > 0` as Promise<Row[]>,
    // A refund is a negative customer_payments row; it is not a payment.
    sql`SELECT total_amount, payment_date FROM customer_payments WHERE client_id = ${clientId} AND company_id = ${sessionCompanyId}::UUID AND status IN ('confirmed', 'reconciled') AND total_amount > 0 ORDER BY payment_date DESC LIMIT 1` as Promise<Row[]>,
    fetchStatementData(sessionCompanyId, clientId, asOf),
  ]);

  // R-095 round 3 (MEDIUM-2): fetchStatementData returns null for a
  // soft-deleted customer or a clientId/companyId pair that doesn't match —
  // the same case statement.ts and invoices.ts 404 on. Without this check,
  // `statementData?.summary.balance ?? 0` quoted a soft-deleted customer a
  // balance of R0 while overdueAmount/openInvoices (plain customer_invoices
  // queries with no customer check) kept answering with the real, nonzero
  // figures — an internally contradictory response, and the only one of the
  // three session routes that didn't refuse a deleted/cross-company customer.
  if (!statementData) {
    return apiResponse.notFound(res, 'Customer', clientId);
  }
  const clientName = String(clients[0]?.name || 'Client');
  const overdueAmount = await getClientOverdue(clientId, sessionCompanyId, asOf, statementData.summary.balance);

  const ctx: ClientContext = {
    clientName,
    outstandingBalance: statementData.summary.balance,
    overdueAmount,
    lastPaymentDate: lastPay[0] ? fmtDate(lastPay[0].payment_date) : '',
    lastPaymentAmount: Number(lastPay[0]?.total_amount ?? 0),
    openInvoices: Number(invoiceCount[0]?.cnt ?? 0),
    companyName: 'IsaFlow',
  };

  // Call Claude
  let chatResponse = null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const prompt = buildClientChatPrompt(question, ctx);
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
      });
      if (response.ok) {
        const data = await response.json() as { content?: { text?: string }[] };
        chatResponse = parseClientChatResponse(data.content?.[0]?.text || '');
        if (chatResponse) chatResponse.message = sanitizeClientResponse(chatResponse.message);
      }
    } catch (err) { log.error('Portal chatbot failed', { error: err }, 'ai'); }
  }

  if (!chatResponse) {
    const amount = `R${Math.abs(ctx.outstandingBalance).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const balance = ctx.outstandingBalance < 0 ? `You are in credit by ${amount}` : `Your outstanding balance is ${amount}`;
    chatResponse = { message: `${balance}. You have ${ctx.openInvoices} open invoice(s).`, action: null };
  }

  log.info('Portal chat', { clientId, queryType }, 'ai');
  return apiResponse.success(res, { ...chatResponse, queryType, clientContext: { balance: ctx.outstandingBalance, overdue: ctx.overdueAmount, openInvoices: ctx.openInvoices } });
}
export default withErrorHandler(handler);
