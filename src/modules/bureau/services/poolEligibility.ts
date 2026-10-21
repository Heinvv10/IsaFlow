/**
 * Shared merchant-pattern pool — which companies may take part (Hein, 2026-10-21, decision 3).
 *
 * v1: a company with no bureau is excluded; a company linked to several bureaus counts only when EVERY
 * linked bureau has opted in (bureaus.share_merchant_patterns, migration 904). Nothing pools yet — PR 2's
 * aggregation job and suggestion reader call these. The pure rule and the SQL agree by construction:
 * `HAVING bool_and(...)` over a company's bureau links is "every linked bureau opted in", and a company
 * with no link has no group, so it is never returned.
 *
 * Runs on the RLS-bypassing pool (bureau tables carry no RLS); it reads flags only, never a company's data.
 *
 * Gate: while MERCHANT_SHARING_ENABLED is off (merchantSharingGate.ts, consent copy pending legal review) every
 * bureau reads as NOT opted in, whatever share_merchant_patterns holds, so nothing here can admit a company.
 */

import { sql } from '@/lib/neon';
import { isMerchantSharingEnabled } from './merchantSharingGate';

export interface LinkedBureauFlag {
  bureauId: string;
  shareMerchantPatterns: boolean;
}

/** Pure: eligible only with at least one linked bureau, and every one of them opted in. */
export function isCompanyPoolEligible(linkedBureaus: LinkedBureauFlag[]): boolean {
  return linkedBureaus.length > 0 && linkedBureaus.every((b) => b.shareMerchantPatterns === true);
}

/** The bureau links of one company with each bureau's opt-in (false for all while the gate is off). */
export async function loadLinkedBureauFlags(companyId: string): Promise<LinkedBureauFlag[]> {
  const gateOn = isMerchantSharingEnabled();
  const rows = (await sql`
    SELECT b.id AS bureau_id, b.share_merchant_patterns
    FROM bureau_companies bc
    JOIN bureaus b ON b.id = bc.bureau_id
    WHERE bc.company_id = ${companyId}::UUID
    ORDER BY b.id
  `) as Array<{ bureau_id: string; share_merchant_patterns: boolean }>;
  return rows.map((r) => ({ bureauId: String(r.bureau_id), shareMerchantPatterns: gateOn && r.share_merchant_patterns === true }));
}

/** Is this company eligible for the pool right now? */
export async function loadCompanyPoolEligibility(companyId: string): Promise<boolean> {
  return isCompanyPoolEligible(await loadLinkedBureauFlags(companyId));
}

/** Every eligible company (for PR 2's aggregation job); none while the gate is off. */
export async function listPoolEligibleCompanyIds(): Promise<string[]> {
  if (!isMerchantSharingEnabled()) return [];
  const rows = (await sql`
    SELECT bc.company_id
    FROM bureau_companies bc
    JOIN bureaus b ON b.id = bc.bureau_id
    GROUP BY bc.company_id
    HAVING bool_and(b.share_merchant_patterns)
    ORDER BY bc.company_id
  `) as Array<{ company_id: string }>;
  return rows.map((r) => String(r.company_id));
}
