/**
 * Shared merchant-pattern pool — the scoped reader (Hein, 2026-10-21, decisions 7 and 8).
 *
 * getSharedSuggestions(companyId, lines): for bank lines nothing of the company's own matched, the pool's
 * category for each line's merchant, translated to the company's OWN GL account through its mapping.
 *   1. Each description goes through the same PII filter the job used; a rejected one is never looked up.
 *   2. shared_pool_lookup (931) answers only for the caller's active company, a company the caller belongs
 *      to, and only if it is pool-eligible; the exact keys asked, at most 500 per call. App roles have no
 *      privilege on the pool table itself.
 *   3. The category becomes the company's own account via company_category_mappings (RLS-bound to the
 *      active company). An unmapped category gives no suggestion. The pool holds no account, so a result
 *      can never name another company's.
 *   4. Below SHARED_POOL_MIN_CONFIDENCE nothing is returned. The floor equals the LLM residual ceiling
 *      (llmCategorizationPass RESIDUAL_CONFIDENCE_CEILING), so a pool suggestion is not handed straight
 *      back to the LLM pass to overwrite.
 *
 * Source 'shared_pool': labelled "Common at other ISAFlow clients" in the bank screen, and NEVER
 * auto-posted (autoPostGate refuses the strategy outright). Non-fatal: a failed lookup costs the
 * suggestion, never the categorisation run (own savepoint, so a request transaction stays usable).
 *
 * Legal-review gate (merchantSharingGate.ts): while MERCHANT_SHARING_ENABLED is off this answers as if the
 * pool were empty, before the filter or any SQL, so no stored pool row is ever served. It does not rely on
 * shared_pool_lookup, which reads the stored opt-in flags and cannot see the server's env.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isMerchantSharingEnabled } from '@/modules/bureau/services/merchantSharingGate';
import type { CategorizationResult } from '../core/smartCategorizationMatchingService';
import { normalisePatternVatCode, toConfidenceLevel } from '../core/smartCategorizationMatchingService';
import { merchantCategory } from './merchantCategories';
import { poolMerchantKey } from './merchantPiiFilter';

export const SHARED_POOL_MIN_CONFIDENCE = 0.6;
export const SHARED_POOL_LABEL = 'Common at other ISAFlow clients';
const MAX_KEYS_PER_LOOKUP = 500;

export interface SharedLookupLine { txId: string; description: string }

interface LookupRow { merchant: string; category_code: string; confidence: string | number }
interface MappingRow {
  category_code: string; gl_account_id: string; account_code: string | null; account_name: string | null;
  default_vat_code: string | null;
}

async function lookup(companyId: string, lines: SharedLookupLine[]): Promise<Map<string, CategorizationResult>> {
  const out = new Map<string, CategorizationResult>();
  const keyOf = new Map<string, string>();
  for (const l of lines) {
    const k = poolMerchantKey(l.description);
    if (k) keyOf.set(l.txId, k);
  }
  const keys = [...new Set(keyOf.values())].slice(0, MAX_KEYS_PER_LOOKUP);
  if (keys.length === 0) return out;

  const hits = (await sql`
    SELECT merchant, category_code, confidence FROM public.shared_pool_lookup(${companyId}::UUID, ${keys}::TEXT[])
  `) as LookupRow[];
  const byMerchant = new Map<string, { category: string; confidence: number }>();
  for (const h of hits) {
    const confidence = Number(h.confidence);
    if (Number.isFinite(confidence) && confidence >= SHARED_POOL_MIN_CONFIDENCE) {
      byMerchant.set(h.merchant, { category: h.category_code, confidence });
    }
  }
  if (byMerchant.size === 0) return out;

  const categories = [...new Set([...byMerchant.values()].map((v) => v.category))];
  const mappings = (await sql`
    SELECT m.category_code, m.gl_account_id, ga.account_code, ga.account_name, ga.default_vat_code
    FROM company_category_mappings m
    JOIN gl_accounts ga ON ga.id = m.gl_account_id AND ga.company_id = m.company_id
    WHERE m.company_id = ${companyId}::UUID AND m.category_code = ANY(${categories}::TEXT[])
      AND COALESCE(ga.is_active, true)
  `) as MappingRow[];
  const accountOf = new Map(mappings.map((m) => [m.category_code, m]));

  for (const [txId, key] of keyOf) {
    const hit = byMerchant.get(key);
    const acct = hit ? accountOf.get(hit.category) : undefined;
    if (!hit || !acct) continue;
    out.set(txId, {
      glAccountId: String(acct.gl_account_id),
      glAccountCode: acct.account_code ?? undefined,
      glAccountName: acct.account_name ?? undefined,
      category: merchantCategory(hit.category)?.label ?? hit.category,
      vatCode: normalisePatternVatCode(null, acct.default_vat_code),
      confidence: hit.confidence,
      confidenceLevel: toConfidenceLevel(hit.confidence),
      matchSource: 'shared_pool',
      matchDetail: SHARED_POOL_LABEL,
    });
  }
  return out;
}

/** Pool suggestions for lines the company's own rules, patterns and history did not match. */
export async function getSharedSuggestions(
  companyId: string, lines: SharedLookupLine[],
): Promise<Map<string, CategorizationResult>> {
  if (lines.length === 0 || !isMerchantSharingEnabled()) return new Map();
  try {
    return await withSavepoint('shared_pool_lookup', () => lookup(companyId, lines));
  } catch (err) {
    log.warn('Shared pool lookup failed; no pool suggestions this run',
      { companyId, error: err instanceof Error ? err.message : String(err) }, 'shared-pool');
    return new Map();
  }
}

/** One description (decision 7's getSharedSuggestion). */
export async function getSharedSuggestion(companyId: string, description: string): Promise<CategorizationResult | null> {
  const r = await getSharedSuggestions(companyId, [{ txId: 'line', description }]);
  return r.get('line') ?? null;
}
