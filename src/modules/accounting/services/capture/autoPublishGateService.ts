/**
 * Auto-Publish Gate Service
 * Evaluates whether a newly captured invoice can be auto-published or must be
 * routed to the review inbox.
 *
 * Decision ladder:
 *   1. Duplicate check  → duplicate_blocked
 *   2. Rule existence   → route_review ('no rule' | 'auto_publish disabled')
 *   3. Confidence gate  → route_review ('confidence too low')
 *   4. Amount cap       → route_review ('over amount cap')
 *   5. PO match flag    → route_review ('PO match required — post to review')
 *   6. All clear        → auto_publish
 */

import { log } from '@/lib/logger';
import { findDuplicate, type DuplicateHit } from './captureDeduplicationService';
import { getRule, type SupplierRule } from './supplierRulesService';

// ── Types ────────────────────────────────────────────────────────────────────

export type GateDecision =
  | { outcome: 'auto_publish'; reason: string; rule: SupplierRule }
  | { outcome: 'route_review'; reasons: string[]; rule: SupplierRule | null }
  | { outcome: 'duplicate_blocked'; hit: DuplicateHit };

export interface GateOptions {
  companyId: string;
  supplierId: string;
  invoiceNumber: string | null;
  totalAmount: number;
  invoiceDate: string;
  vatNumber: string | null;
  extractionConfidence: number;
}

// ── Gate ─────────────────────────────────────────────────────────────────────

export async function decide(opts: GateOptions): Promise<GateDecision> {
  const {
    companyId,
    supplierId,
    invoiceNumber,
    totalAmount,
    invoiceDate,
    vatNumber,
    extractionConfidence,
  } = opts;

  // Step 1: Duplicate detection
  const hit = await findDuplicate(
    companyId,
    supplierId,
    invoiceNumber,
    totalAmount,
    invoiceDate,
    vatNumber,
  );

  if (hit) {
    log.info('Gate decision: duplicate_blocked', {
      companyId,
      supplierId,
      outcome: 'duplicate_blocked',
      reason: `Existing invoice ${hit.supplierInvoiceId} (confidence ${hit.confidence})`,
    }, 'auto-publish-gate');
    return { outcome: 'duplicate_blocked', hit };
  }

  // Step 2: Load rule
  const rule = await getRule(companyId, supplierId);

  if (!rule) {
    log.info('Gate decision: route_review', {
      companyId,
      supplierId,
      outcome: 'route_review',
      reason: 'no rule',
    }, 'auto-publish-gate');
    return { outcome: 'route_review', reasons: ['no rule'], rule: null };
  }

  if (!rule.autoPublish) {
    log.info('Gate decision: route_review', {
      companyId,
      supplierId,
      outcome: 'route_review',
      reason: 'auto_publish disabled',
    }, 'auto-publish-gate');
    return { outcome: 'route_review', reasons: ['auto_publish disabled'], rule };
  }

  // Step 3: Confidence gate
  const routeReasons: string[] = [];

  if (extractionConfidence < rule.autoPublishMinConfidence) {
    routeReasons.push(
      `confidence too low (${extractionConfidence.toFixed(4)} < ${rule.autoPublishMinConfidence.toFixed(4)})`,
    );
  }

  // Step 4: Amount cap
  if (rule.autoPublishMaxAmount != null && totalAmount > rule.autoPublishMaxAmount) {
    routeReasons.push(
      `over amount cap (${totalAmount} > ${rule.autoPublishMaxAmount})`,
    );
  }

  // Step 5: PO match required — route to review; actual 3-way match runs post-creation
  if (rule.requirePoMatch) {
    routeReasons.push('PO match required — post to review');
  }

  if (routeReasons.length > 0) {
    log.info('Gate decision: route_review', {
      companyId,
      supplierId,
      outcome: 'route_review',
      reasons: routeReasons,
    }, 'auto-publish-gate');
    return { outcome: 'route_review', reasons: routeReasons, rule };
  }

  // Step 6: All clear
  log.info('Gate decision: auto_publish', {
    companyId,
    supplierId,
    outcome: 'auto_publish',
    reason: 'rule satisfied',
  }, 'auto-publish-gate');
  return { outcome: 'auto_publish', reason: 'rule satisfied', rule };
}
