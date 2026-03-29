/**
 * Portal Chatbot API
 * POST: client asks a question, gets AI-powered response
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { classifyClientQuery, buildClientChatPrompt, parseClientChatResponse, sanitizeClientResponse, type ClientContext } from '@/modules/accounting/services/portalChatbotService';
import { jwtVerify } from 'jose';
import cookie from 'cookie';

const PORTAL_SECRET = new TextEncoder().encode(
  (() => { if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required'); return process.env.JWT_SECRET + '-portal'; })()
);

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  // Authenticate portal session
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies.portal_session;
  if (!token) return res.status(401).json({ success: false, error: { message: 'Not authenticated' } });
  let sessionClientId: string;
  try {
    const { payload } = await jwtVerify(token, PORTAL_SECRET);
    sessionClientId = payload.clientId as string;
  } catch {
    return res.status(401).json({ success: false, error: { message: 'Invalid session' } });
  }

  const { question, clientId } = req.body;
  if (!question) return apiResponse.badRequest(res, 'question is required');
  if (!clientId || clientId !== sessionClientId) return apiResponse.badRequest(res, 'clientId mismatch or missing');
  if (question.length > 500) return apiResponse.badRequest(res, 'question too long (max 500 chars)');

  const queryType = classifyClientQuery(question);

  // Build client context from DB
  const clients = await sql`SELECT name FROM customers WHERE id = ${clientId} LIMIT 1` as Row[];
  const clientName = String(clients[0]?.name || 'Client');

  const balanceRows = await sql`SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) as outstanding FROM customer_invoices WHERE customer_id = ${clientId} AND status NOT IN ('cancelled', 'draft', 'paid')` as Row[];
  const overdueRows = await sql`SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) as overdue FROM customer_invoices WHERE customer_id = ${clientId} AND status NOT IN ('cancelled', 'draft', 'paid') AND due_date < CURRENT_DATE` as Row[];
  const invoiceCount = await sql`SELECT COUNT(*) as cnt FROM customer_invoices WHERE customer_id = ${clientId} AND status NOT IN ('cancelled', 'draft', 'paid')` as Row[];
  const lastPay = await sql`SELECT amount, payment_date FROM customer_payments WHERE customer_id = ${clientId} ORDER BY payment_date DESC LIMIT 1` as Row[];

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
        const data = await response.json() as any;
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
