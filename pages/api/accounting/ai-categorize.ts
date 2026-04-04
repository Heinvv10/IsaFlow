/**
 * AI Transaction Categorization API
 * POST: categorize a bank transaction using tiered strategy (Rules → Patterns → Claude LLM)
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  buildCategorizationPrompt,
  parseCategorizationResponse,
  selectCategorizationStrategy,
  calculateConfidence,
  mergeCategorizationResults,
  type TransactionContext,
  type ChartOfAccountEntry,
  type CategorizationResult,
} from '@/modules/accounting/services/aiCategorizationService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { transactionId, description, amount, date } = req.body;
  if (!description) return apiResponse.badRequest(res, 'Transaction description is required');

  const companyId = (req as any).companyId as string;
  const isDebit = Number(amount || 0) < 0;

  const tx: TransactionContext = {
    description: String(description),
    amount: Number(amount || 0),
    date: String(date || new Date().toISOString().split('T')[0]),
    isDebit,
  };

  // Step 1: Check rules (match_value against description)
  let ruleResult: CategorizationResult | null = null;
  try {
    const rules = await sql`
      SELECT r.gl_account_id, r.priority, r.vat_code, ga.account_code, ga.account_name, ga.default_vat_code
      FROM bank_categorisation_rules r
      LEFT JOIN gl_accounts ga ON r.gl_account_id = ga.id
      WHERE r.is_active = true AND ${tx.description} ILIKE CONCAT('%', r.match_value, '%')
      ORDER BY r.priority DESC LIMIT 1
    ` as Row[];
    if (rules[0]) {
      const ruleVat = String(rules[0].vat_code || rules[0].default_vat_code || 'none');
      ruleResult = {
        accountCode: String(rules[0].account_code || ''),
        accountName: String(rules[0].account_name || ''),
        confidence: 1.0,
        reason: 'Matched bank categorisation rule',
        strategy: 'rules',
        vatCode: ruleVat as CategorizationResult['vatCode'],
      };
    }
  } catch { /* rules table might not have data */ }

  // Step 2: Check learned patterns
  let patternResult: CategorizationResult | null = null;
  try {
    const patterns = await sql`
      SELECT p.gl_account_id, p.confidence, p.vat_code, ga.account_code, ga.account_name, ga.default_vat_code
      FROM categorization_patterns p
      LEFT JOIN gl_accounts ga ON p.gl_account_id = ga.id
      WHERE ${tx.description} ILIKE CONCAT('%', p.pattern, '%')
      ORDER BY p.confidence DESC LIMIT 1
    ` as Row[];
    if (patterns[0]) {
      const patternVat = String(patterns[0].vat_code || patterns[0].default_vat_code || 'standard');
      patternResult = {
        accountCode: String(patterns[0].account_code || ''),
        accountName: String(patterns[0].account_name || ''),
        confidence: Number(patterns[0].confidence || 0.7),
        reason: 'Matched learned pattern',
        strategy: 'patterns',
        vatCode: patternVat as CategorizationResult['vatCode'],
      };
    }
  } catch { /* patterns table might not have data */ }

  // Step 3: Determine if we need LLM
  const strategy = selectCategorizationStrategy({
    hasRuleMatch: !!ruleResult,
    hasPatternMatch: !!patternResult,
    ruleConfidence: ruleResult?.confidence ?? 0,
    patternConfidence: patternResult?.confidence ?? 0,
  });

  const results: CategorizationResult[] = [];
  if (ruleResult) results.push(ruleResult);
  if (patternResult) results.push(patternResult);

  let llmUsed = false;

  if (strategy === 'llm') {
    // Get chart of accounts for prompt (include default VAT codes for context)
    const accounts = await sql`
      SELECT account_code as code, account_name as name, account_type as type, default_vat_code
      FROM gl_accounts WHERE is_active = true AND company_id = ${companyId}::UUID
      ORDER BY account_code LIMIT 50
    ` as Row[];

    const coaEntries: ChartOfAccountEntry[] = accounts.map((a: any) => ({
      code: String(a.code), name: String(a.name), type: String(a.type),
      defaultVatCode: a.default_vat_code ? String(a.default_vat_code) : undefined,
    }));

    const prompt = buildCategorizationPrompt(tx, coaEntries);

    // Call Claude API if ANTHROPIC_API_KEY is set
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json() as any;
          const text = data.content?.[0]?.text || '';
          const llmResult = parseCategorizationResponse(text);
          if (llmResult) {
            results.push(llmResult);
            llmUsed = true;
          }
        }
      } catch (err) {
        log.error('Claude API call failed', { error: err }, 'ai');
      }
    } else {
      log.info('ANTHROPIC_API_KEY not set, skipping LLM categorization', {}, 'ai');
    }
  }

  const merged = mergeCategorizationResults(results);
  const confidence = calculateConfidence(merged.confidence);

  log.info('AI categorization completed', {
    description: tx.description,
    strategy,
    llmUsed,
    result: merged.accountCode,
    confidence: merged.confidence,
  }, 'ai');

  // If no VAT code from the categorization pipeline, fall back to GL account default
  if (!merged.vatCode || merged.vatCode === 'none') {
    try {
      const [acct] = await sql`
        SELECT default_vat_code FROM gl_accounts
        WHERE account_code = ${merged.accountCode} AND company_id = ${companyId}::UUID AND is_active = true
        LIMIT 1
      ` as Row[];
      if (acct?.default_vat_code && acct.default_vat_code !== 'none') {
        merged.vatCode = String(acct.default_vat_code) as CategorizationResult['vatCode'];
        merged.vatReason = 'Default VAT for this account type';
      }
    } catch { /* non-critical */ }
  }

  return apiResponse.success(res, {
    ...merged,
    confidenceLevel: confidence,
    strategyUsed: strategy,
    llmUsed,
  });
}

export default withCompany(withErrorHandler(handler));
