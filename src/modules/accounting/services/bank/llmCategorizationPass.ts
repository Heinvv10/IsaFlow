/**
 * In-process LLM categorization pass over the uncertain residual of a smart
 * categorize. Fire-and-forget: the caller does NOT await it; results land in
 * bank_transactions as each Haiku call settles. Re-runnable + idempotent.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runWithConcurrency } from '@/lib/bulkUpload/concurrencyQueue';
import {
  buildCategorizationPrompt,
  parseCategorizationResponse,
  type ChartOfAccountEntry,
} from '@/modules/accounting/services/core/aiCategorizationService';
import { sweep as gateSweep, getAutoPostSettings } from './autoPostGateService';

// ─── Residual selector ────────────────────────────────────────────────────────

/** A transaction is "residual" if imported AND (no suggestion OR confidence < MEDIUM). */
export const RESIDUAL_CONFIDENCE_CEILING = 0.6;

export interface ResidualCandidate {
  id: string;
  status: string;
  suggestedGlAccountId: string | null;
  suggestedConfidence: number | null;
}

export function selectResidualTxIds(rows: ResidualCandidate[], maxCalls: number): string[] {
  const ids: string[] = [];
  for (const r of rows) {
    if (r.status !== 'imported') continue;
    const uncertain =
      r.suggestedGlAccountId == null ||
      r.suggestedConfidence == null ||
      r.suggestedConfidence < RESIDUAL_CONFIDENCE_CEILING;
    if (uncertain) ids.push(r.id);
    if (ids.length >= maxCalls) break;
  }
  return ids;
}

// ─── LLM seam + types ────────────────────────────────────────────────────────

export interface LlmTxContext {
  id: string;
  status: string;
  suggestedGlAccountId: string | null;
  suggestedConfidence: number | null;
  description: string;
  amount: number;
  transactionDate: string;
}

export interface LlmCatResult {
  glAccountId: string;
  vatCode?: string;
  confidence: number;
  accountCode: string;
  accountName: string;
}

/** Single LLM seam — spied in tests. Resolves null when no key / no usable answer. */
export async function categorizeOneWithLlm(
  tx: LlmTxContext,
  accounts: Array<ChartOfAccountEntry & { id?: string }>,
): Promise<LlmCatResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const prompt = buildCategorizationPrompt(
    { description: tx.description, amount: tx.amount, date: tx.transactionDate, isDebit: tx.amount < 0 },
    accounts,
  );
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    log.warn('LLM categorize call failed', { status: resp.status, txId: tx.id }, 'llm-pass');
    return null;
  }
  const body = (await resp.json()) as { content?: Array<{ text?: string }> };
  const parsed = parseCategorizationResponse(body.content?.[0]?.text ?? '');
  if (!parsed?.accountCode) return null;
  const acct = accounts.find(a => a.code === parsed.accountCode);
  if (!acct) return null;
  return {
    glAccountId: (acct as ChartOfAccountEntry & { id?: string }).id ?? parsed.accountCode,
    vatCode: parsed.vatCode,
    confidence: parsed.confidence,
    accountCode: parsed.accountCode,
    accountName: acct.name,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export interface RunDeps {
  llmEnabled: boolean;
  maxCalls: number;
  dailyRemaining: number;
  loadAccounts: () => Promise<Array<ChartOfAccountEntry & { id?: string }>>;
  loadCandidates: () => Promise<LlmTxContext[]>;
  persist: (txId: string, r: LlmCatResult) => Promise<void>;
  sweep: (txIds: string[]) => Promise<{ runId: string | null; posted: number; skipped: unknown[] }>;
  /** Optional override seam — injected by tests instead of spying the module export. */
  categorizeOne?: (
    tx: LlmTxContext,
    accounts: Array<ChartOfAccountEntry & { id?: string }>,
  ) => Promise<LlmCatResult | null>;
}

export async function runLlmResidualPass(
  companyId: string,
  txIds: string[],
  userId: string,
  deps: RunDeps,
): Promise<void> {
  // Suppress unused-variable warnings — companyId / txIds / userId used in
  // production default deps; kept here so callers always pass context.
  void txIds;
  void userId;
  try {
    if (!deps.llmEnabled) return; // LLM tier not opted in → no Anthropic spend
    if (deps.dailyRemaining <= 0) {
      log.warn('LLM pass skipped — daily ceiling reached', { companyId }, 'llm-pass');
      return;
    }
    const candidates = await deps.loadCandidates();
    const cap = Math.min(deps.maxCalls, deps.dailyRemaining);
    const residualIds = selectResidualTxIds(candidates, cap);
    if (residualIds.length === 0) return;
    if (candidates.length > residualIds.length && residualIds.length === cap) {
      log.warn('LLM pass truncated to cap', { companyId, cap }, 'llm-pass');
    }
    const byId = new Map(candidates.map(c => [c.id, c]));
    const accounts = await deps.loadAccounts();
    const tagged: string[] = [];
    const catFn = deps.categorizeOne ?? categorizeOneWithLlm;
    const settled = await runWithConcurrency(residualIds, 4, async (id) => {
      const tx = byId.get(id);
      if (!tx) return;
      const r = await catFn(tx, accounts);
      if (r) {
        await deps.persist(id, r);
        tagged.push(id);
      }
    });
    const failures = settled.filter((s) => s && s.status === 'rejected').length;
    if (failures > 0) {
      log.warn('LLM pass: some residual items failed', { companyId, failures, attempted: residualIds.length }, 'llm-pass');
    }
    if (tagged.length > 0) await deps.sweep(tagged);
  } catch (err) {
    log.warn(
      'LLM residual pass aborted',
      { companyId, error: err instanceof Error ? err.message : String(err) },
      'llm-pass',
    );
  }
}

// ─── Production default deps builders (used by Task 9) ───────────────────────
// Exported so the smart-categorize API can compose them.

export async function loadAccountsForCompany(
  companyId: string,
): Promise<Array<ChartOfAccountEntry & { id?: string }>> {
  const rows = await sql`
    SELECT id, account_code AS code, account_name AS name, account_type AS type
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID
      AND is_active = true
    ORDER BY account_code
  `;
  return rows as Array<ChartOfAccountEntry & { id?: string }>;
}

export async function loadCandidatesForTxIds(
  companyId: string,
  txIds: string[],
): Promise<LlmTxContext[]> {
  if (txIds.length === 0) return [];
  const rows = await sql`
    SELECT id, status, suggested_gl_account_id, suggested_confidence,
           description, amount, transaction_date
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${txIds}::uuid[])
  `;
  return rows.map((r: Record<string, unknown>) => ({
    id: r['id'] as string,
    status: r['status'] as string,
    suggestedGlAccountId: (r['suggested_gl_account_id'] as string | null) ?? null,
    suggestedConfidence: r['suggested_confidence'] == null ? null : Number(r['suggested_confidence']),
    description: (r['description'] as string) ?? '',
    amount: Number(r['amount']),
    transactionDate: r['transaction_date'] instanceof Date
      ? (r['transaction_date'] as Date).toISOString().slice(0, 10)
      : String(r['transaction_date'] ?? ''),
  }));
}

export async function persistLlmResult(
  companyId: string,
  txId: string,
  r: LlmCatResult,
): Promise<void> {
  await sql`
    UPDATE bank_transactions
    SET suggested_gl_account_id = ${r.glAccountId},
        suggested_confidence    = ${r.confidence},
        suggested_vat_code      = ${r.vatCode ?? null},
        suggested_strategy      = 'llm',
        updated_at              = NOW()
    WHERE id = ${txId}::UUID
      AND company_id = ${companyId}::UUID
  `;
}

// ─── Daily ceiling helpers ────────────────────────────────────────────────────

export const MAX_LLM_CALLS_PER_RUN = 200;
export const DAILY_LLM_CEILING = 1000;

/** Pure arithmetic — separated for unit-testability. */
export function remainingFromCount(count: number): number {
  return Math.max(0, DAILY_LLM_CEILING - count);
}

/** Remaining LLM-call headroom for the company today (under DAILY_LLM_CEILING). */
export async function llmCallsRemainingToday(companyId: string): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS n
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID
      AND suggested_strategy = 'llm'
      AND updated_at >= date_trunc('day', NOW())
  ` as Array<{ n: number }>;
  return remainingFromCount(rows[0]?.n ?? 0);
}

// ─── RunDeps composer (single source of truth for endpoints) ─────────────────

/** Builds production RunDeps for a residual id set. */
export async function buildRunDeps(
  companyId: string,
  userId: string,
  txIds: string[],
): Promise<RunDeps> {
  const settings = await getAutoPostSettings(companyId);
  return {
    llmEnabled: settings.llmEnabled,
    maxCalls: MAX_LLM_CALLS_PER_RUN,
    dailyRemaining: await llmCallsRemainingToday(companyId),
    loadAccounts: () => loadAccountsForCompany(companyId),
    loadCandidates: () => loadCandidatesForTxIds(companyId, txIds),
    persist: (txId, r) => persistLlmResult(companyId, txId, r),
    sweep: (ids) => gateSweep(companyId, ids, 'categorization', userId),
  };
}
