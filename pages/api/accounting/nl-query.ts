/**
 * Natural Language Financial Query API
 * POST: ask a question in plain English, get data back
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import type { CompanyApiRequest } from '@/lib/auth/withCompany';
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
  { name: 'bank_accounts', columns: ['id', 'account_name', 'bank_name', 'account_number', 'company_id'], description: 'Bank accounts — always JOIN to bank_transactions to scope by company_id' },
  { name: 'bank_transactions', columns: ['id', 'bank_account_id', 'date', 'description', 'amount', 'category', 'is_reconciled'], description: 'Imported bank transactions — has NO company_id column; scope via JOIN bank_accounts ba ON bt.bank_account_id = ba.id WHERE ba.company_id = \'<company_id>\'' },
  { name: 'products', columns: ['id', 'code', 'name', 'cost_price', 'selling_price', 'current_stock', 'company_id'], description: 'Products/inventory items' },
  { name: 'employees', columns: ['id', 'first_name', 'last_name', 'email', 'basic_salary', 'employment_type', 'company_id'], description: 'Employee master data' },
  { name: 'payslips', columns: ['id', 'employee_id', 'payroll_run_id', 'gross_pay', 'net_pay', 'paye', 'uif_employee'], description: 'Payslips per payroll run' },
  { name: 'projects', columns: ['id', 'project_number', 'name', 'client_id', 'status', 'budget_amount', 'total_revenue', 'total_cost'], description: 'Projects/jobs' },
];

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (checkRateLimit(`nl-query:${ip}`, { maxRequests: 30, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
  }

  const { question } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length < 3) {
    return apiResponse.badRequest(res, 'Please ask a question (minimum 3 characters)');
  }
  if (question.length > 500) {
    return apiResponse.badRequest(res, 'Question is too long (maximum 500 characters)');
  }

  const companyId = (req as CompanyApiRequest).companyId;
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
    const aiAbort = new AbortController();
    const aiTimeout = setTimeout(() => aiAbort.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
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
        signal: aiAbort.signal,
      });
    } finally {
      clearTimeout(aiTimeout);
    }

    if (!response.ok) {
      return apiResponse.success(res, { intent, message: 'AI service unavailable', rows: [], columns: [], summary: 'Service error' });
    }

    const data = await response.json() as { content?: { text?: string }[] };
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

    // Execute the validated SQL inside a genuine pg.Pool transaction so that
    // SET LOCAL statement_timeout is honoured for the AI-generated query on the
    // same connection.
    //
    // WHY NOT sql.transaction() (Neon HTTP driver):
    //   The HTTP driver's transaction() only accepts tagged-template NeonQueryPromise
    //   objects. txn.unsafe() returns UnsafeRawSql — a different class — which
    //   transaction() rejects at runtime with:
    //     "transaction() expects an array of queries, or a function returning an array"
    //
    // withTransaction() uses a real pg.Pool client with BEGIN/COMMIT, and the tx
    // tagged-template helper correctly builds a parameterised query from a raw string
    // by passing it as a single-element template-strings array with no interpolations.
    const rawSql = validation.sanitizedSQL;
    const rows = await withTransaction(async (tx) => {
      await tx`SET LOCAL statement_timeout = '5000'`;
      // Invoke the tagged-template helper with the raw SQL as a synthetic TemplateStringsArray
      // (no interpolations — all values are already inlined in the validated SQL string).
      return tx(Object.assign([rawSql], { raw: [rawSql] }) as unknown as TemplateStringsArray) as unknown as Row[];
    });
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

export default withCompany(withErrorHandler(withWriteAccess(handler)));
