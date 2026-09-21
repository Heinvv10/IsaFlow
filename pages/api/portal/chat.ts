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
import { verifyArPortalToken } from '@/lib/auth/arPortalJwt';
import cookie from 'cookie';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies.portal_session;
  if (!token) return res.status(401).json({ success: false, error: { message: 'Not authenticated' } });
  const session = await verifyArPortalToken(token);
  if (!session) {
    return res.status(401).json({ success: false, error: { message: 'Invalid session' } });
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
  const [clients, balanceRows, overdueRows, invoiceCount, lastPay] = await Promise.all([
    sql`SELECT name FROM customers WHERE id = ${clientId} AND company_id = ${sessionCompanyId}::UUID LIMIT 1` as Promise<Row[]>,
    // K-053: the portal quotes the customer a balance, so it asks the same
    // dated soft-delete question the ageing and the control account ask.
    sql`SELECT COALESCE(SUM(ci.total_amount - COALESCE(ci.amount_paid, 0)), 0) as outstanding FROM customer_invoices ci WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId} AND ci.company_id = ${sessionCompanyId}::UUID AND ${documentInLedgerAsAtFragment('ci', asAtTodayStr(), sessionCompanyId)} AND ci.status NOT IN ('cancelled', 'draft', 'paid')` as Promise<Row[]>,
    sql`SELECT COALESCE(SUM(ci.total_amount - COALESCE(ci.amount_paid, 0)), 0) as overdue FROM customer_invoices ci WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId} AND ci.company_id = ${sessionCompanyId}::UUID AND ${documentInLedgerAsAtFragment('ci', asAtTodayStr(), sessionCompanyId)} AND ci.status NOT IN ('cancelled', 'draft', 'paid') AND ci.due_date < CURRENT_DATE` as Promise<Row[]>,
    sql`SELECT COUNT(*) as cnt FROM customer_invoices ci WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId} AND ci.company_id = ${sessionCompanyId}::UUID AND ${documentInLedgerAsAtFragment('ci', asAtTodayStr(), sessionCompanyId)} AND ci.status NOT IN ('cancelled', 'draft', 'paid')` as Promise<Row[]>,
    sql`SELECT amount, payment_date FROM customer_payments WHERE COALESCE(client_id, customer_id) = ${clientId} AND company_id = ${sessionCompanyId}::UUID ORDER BY payment_date DESC LIMIT 1` as Promise<Row[]>,
  ]);
  const clientName = String(clients[0]?.name || 'Client');

  const ctx: ClientContext = {
    clientName,
    outstandingBalance: Number(balanceRows[0]?.outstanding ?? 0),
    overdueAmount: Number(overdueRows[0]?.overdue ?? 0),
    lastPaymentDate: lastPay[0] ? String(lastPay[0].payment_date) : '',
    lastPaymentAmount: Number(lastPay[0]?.amount ?? 0),
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
    chatResponse = { message: `Your outstanding balance is R${ctx.outstandingBalance.toLocaleString()}. You have ${ctx.openInvoices} open invoice(s).`, action: null };
  }

  log.info('Portal chat', { clientId, queryType }, 'ai');
  return apiResponse.success(res, { ...chatResponse, queryType, clientContext: { balance: ctx.outstandingBalance, overdue: ctx.overdueAmount, openInvoices: ctx.openInvoices } });
}
export default withErrorHandler(handler);
