/**
 * Natural Language Financial Query API
 * POST: ask a question in plain English, get data back
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  buildTextToSQLPrompt, parseSQLResponse, validateGeneratedSQL,
  formatQueryResult, buildSchemaDescription, classifyQueryIntent,
  type SchemaTable,
} from '@/modules/accounting/services/nlQueryService';

type Row = Record<string, unknown>;

const SCHEMA_TABLES: SchemaTable[] = [
  { name: 'customer_invoices', columns: ['id', 'customer_id', 'invoice_number', 'invoice_date', 'due_date', 'total_amount', 'amount_paid', 'status', 'company_id'], description: 'Customer/sales invoices' },
  { name: 'customers', columns: ['id', 'name', 'email', 'payment_terms', 'is_active', 'company_id'], description: 'Customer master data' },
  { name: 'supplier_invoices', columns: ['id', 'supplier_id', 'invoice_number', 'invoice_date', 'total_amount', 'amount_paid', 'status', 'company_id'], description: 'Supplier/purchase invoices' },
  { name: 'suppliers', columns: ['id', 'name', 'email', 'is_active', 'company_id'], description: 'Supplier master data' },
  { name: 'gl_accounts', columns: ['id', 'account_code', 'account_name', 'account_type', 'is_active', 'company_id'], description: 'Chart of accounts (GL)' },
  { name: 'gl_journal_entries', columns: ['id', 'entry_number', 'entry_date', 'description', 'status', 'source'], description: 'Journal entries' },
  { name: 'gl_journal_lines', columns: ['id', 'journal_entry_id', 'gl_account_id', 'debit', 'credit', 'description'], description: 'Journal entry lines (debits/credits)' },
  { name: 'bank_transactions', columns: ['id', 'bank_account_id', 'date', 'description', 'amount', 'category', 'is_reconciled'], description: 'Imported bank transactions' },
  { name: 'products', columns: ['id', 'code', 'name', 'cost_price', 'selling_price', 'current_stock', 'company_id'], description: 'Products/inventory items' },
  { name: 'employees', columns: ['id', 'first_name', 'last_name', 'email', 'basic_salary', 'employment_type', 'company_id'], description: 'Employee master data' },
  { name: 'payslips', columns: ['id', 'employee_id', 'payroll_run_id', 'gross_pay', 'net_pay', 'paye', 'uif_employee'], description: 'Payslips per payroll run' },
  { name: 'projects', columns: ['id', 'project_number', 'name', 'client_id', 'status', 'budget_amount', 'total_revenue', 'total_cost'], description: 'Projects/jobs' },
];

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { question } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length < 3) {
    return apiResponse.badRequest(res, 'Please ask a question (minimum 3 characters)');
  }
  if (question.length > 500) {
    return apiResponse.badRequest(res, 'Question is too long (maximum 500 characters)');
  }

  const companyId = (req as any).companyId as string;
  const intent = classifyQueryIntent(question);
  const schemaDesc = buildSchemaDescription(SCHEMA_TABLES);
  const prompt = buildTextToSQLPrompt(question, schemaDesc, companyId);

  // Call Claude
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return apiResponse.success(res, {
      intent,
      message: 'Natural language queries require ANTHROPIC_API_KEY to be configured.',
      rows: [], columns: [], summary: 'AI not configured',
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      return apiResponse.success(res, { intent, message: 'AI service unavailable', rows: [], columns: [], summary: 'Service error' });
    }

    const data = await response.json() as any;
    const text = data.content?.[0]?.text || '';
    const parsed = parseSQLResponse(text);

    if (!parsed) {
      return apiResponse.success(res, { intent, message: 'Could not generate a query for that question.', explanation: text, rows: [], columns: [], summary: 'Unable to parse' });
    }

    // Validate SQL
    const validation = validateGeneratedSQL(parsed.sql);
    if (!validation.valid) {
      return apiResponse.success(res, { intent, message: `Generated SQL was rejected: ${validation.error}`, rows: [], columns: [], summary: 'Query rejected' });
    }

    // Verify company_id appears in an actual "company_id = '<uuid>'" predicate,
    // not just anywhere in the string (e.g. a comment, alias, or lucky substring).
    const scopeRegex = new RegExp(`company_id\\s*=\\s*'${companyId}'`, 'i');
    if (!scopeRegex.test(validation.sanitizedSQL)) {
      log.warn('NL query missing company_id scope — rejected', { question, companyId }, 'ai');
      return apiResponse.success(res, { intent, message: 'Could not generate a properly scoped query. Please try again.', rows: [], columns: [], summary: 'Scope error' });
    }

    // Execute inside a transaction so SET LOCAL applies to the same connection.
    // Neon HTTP driver is stateless — each top-level sql`` call is a separate
    // HTTP request, so a bare SET statement_timeout would have no effect on the
    // next call.  sql.transaction() batches both statements into a single HTTP
    // request, guaranteeing SET LOCAL is honoured for the query that follows it.
    const [, rows] = await sql.transaction(
      (txn) => [
        txn`SET LOCAL statement_timeout = '5000'`,
        txn.unsafe(validation.sanitizedSQL) as any,
      ]
    ) as [unknown, Row[]];
    const formatted = formatQueryResult(rows as Record<string, unknown>[], question);

    log.info('NL query executed', { question, intent, rowCount: formatted.rowCount }, 'ai');

    return apiResponse.success(res, {
      intent,
      question,
      sql: validation.sanitizedSQL,
      explanation: parsed.explanation,
      ...formatted,
    });
  } catch (err) {
    log.error('NL query failed', { error: err }, 'ai');
    return apiResponse.success(res, { intent, message: 'Query execution failed', rows: [], columns: [], summary: 'Error' });
  }
}

export default withCompany(withErrorHandler(handler));
