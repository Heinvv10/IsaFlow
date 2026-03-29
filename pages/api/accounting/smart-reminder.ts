/**
 * Smart Collection Reminder API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { generateReminderMessage, selectReminderTone, calculateEscalationLevel, buildCollectionPlan, type DebtorProfile } from '@/modules/accounting/services/smartCollectionsService';
type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { customerId, reminderNumber = 1 } = req.body;
  if (!customerId) return apiResponse.badRequest(res, 'customerId is required');

  const customers = await sql`SELECT name, email, contact_person FROM customers WHERE id = ${customerId} LIMIT 1` as Row[];
  if (!customers[0]) return apiResponse.notFound(res, 'Customer', customerId);
  const c = customers[0] as any;

  const balRow = await sql`SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid,0)),0) as bal, COUNT(*) as cnt, MIN(due_date) as oldest FROM customer_invoices WHERE customer_id = ${customerId} AND status NOT IN ('cancelled','draft','paid') AND due_date < CURRENT_DATE` as Row[];
  const outstanding = Number(balRow[0]?.bal ?? 0);
  const invoiceCount = Number(balRow[0]?.cnt ?? 0);
  const oldestDue = balRow[0]?.oldest ? Math.floor((Date.now() - new Date(String(balRow[0].oldest)).getTime()) / 86400000) : 0;

  const debtor: DebtorProfile = { name: c.name, contactPerson: c.contact_person || c.name, email: c.email || '', outstandingAmount: outstanding, oldestInvoiceDays: oldestDue, invoiceCount, companyName: 'IsaFlow' };
  const tone = selectReminderTone(reminderNumber, oldestDue);
  const message = generateReminderMessage(debtor, tone);
  const escalation = calculateEscalationLevel(oldestDue, outstanding);
  const plan = buildCollectionPlan(outstanding, oldestDue);

  return apiResponse.success(res, { message, tone, escalation, plan, debtor: { name: c.name, outstanding, overdueDays: oldestDue, invoiceCount } });
}
export default withCompany(withErrorHandler(handler as any));
