/**
 * Duplicate Detection Service — Detection
 * PRD: WS-6.6 — Duplicate Detection and Merge Wizard
 *
 * Detects potential duplicate customers, suppliers, and items using
 * fuzzy name matching, exact email matching, and VAT number matching.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fuzzyMatch } from '@/modules/accounting/utils/fuzzyMatcher';
import { mergeEntities } from './duplicateMergeService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DuplicateEntity {
  id: string;
  name: string;
  email?: string;
  vatNumber?: string;
  phone?: string;
  [key: string]: unknown;
}

export interface DuplicatePair {
  entityType: 'customer' | 'supplier' | 'item';
  primary: DuplicateEntity;
  duplicate: DuplicateEntity;
  confidence: number;   // 0–100
  matchReasons: string[];
}

// Re-export merge so consumers only need one import
export { mergeEntities };
export type { MergeResult } from './duplicateMergeService';

// ── Public API ────────────────────────────────────────────────────────────────

export async function detectDuplicates(
  companyId: string,
  entityType: 'customer' | 'supplier' | 'item',
): Promise<DuplicatePair[]> {
  log.info('Detecting duplicates', { companyId, entityType }, 'duplicate-detection');

  if (entityType === 'customer') return detectCustomerDuplicates(companyId);
  if (entityType === 'supplier') return detectSupplierDuplicates(companyId);
  return detectItemDuplicates(companyId);
}

// ── Customer detection ────────────────────────────────────────────────────────

async function detectCustomerDuplicates(companyId: string): Promise<DuplicatePair[]> {
  const rows = (await sql`
    SELECT id, name, email, vat_number, phone, registration_number, contact_person, billing_address
    FROM customers
    WHERE company_id = ${companyId}::UUID
      AND deleted_at IS NULL
      AND is_active = true
    ORDER BY name
  `) as Row[];

  const entities: DuplicateEntity[] = rows.map((r: Row) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    vatNumber: r.vat_number,
    phone: r.phone,
    registrationNumber: r.registration_number,
    contactPerson: r.contact_person,
    billingAddress: r.billing_address,
  }));

  const pairs = findDuplicatePairs(entities, 'customer', 0.85);
  log.info('Customer duplicate scan complete', { count: pairs.length, companyId }, 'duplicate-detection');
  return pairs;
}

// ── Supplier detection ────────────────────────────────────────────────────────

async function detectSupplierDuplicates(companyId: string): Promise<DuplicatePair[]> {
  const rows = (await sql`
    SELECT id, name, email, vat_number, phone, registration_number, contact_person, address
    FROM suppliers
    WHERE company_id = ${companyId}::UUID
      AND deleted_at IS NULL
      AND is_active = true
    ORDER BY name
  `) as Row[];

  const entities: DuplicateEntity[] = rows.map((r: Row) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    vatNumber: r.vat_number,
    phone: r.phone,
    registrationNumber: r.registration_number,
    contactPerson: r.contact_person,
    address: r.address,
  }));

  const pairs = findDuplicatePairs(entities, 'supplier', 0.85);
  log.info('Supplier duplicate scan complete', { count: pairs.length, companyId }, 'duplicate-detection');
  return pairs;
}

// ── Item detection ────────────────────────────────────────────────────────────

async function detectItemDuplicates(companyId: string): Promise<DuplicatePair[]> {
  const rows = (await sql`
    SELECT id, code, description, item_type, unit, cost_price, selling_price_excl
    FROM items
    WHERE company_id = ${companyId}::UUID
      AND deleted_at IS NULL
      AND is_active = true
    ORDER BY code
  `) as Row[];

  const pairs: DuplicatePair[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i] as Row;
      const b = rows[j] as Row;
      const pairKey = [a.id as string, b.id as string].sort().join(':');
      if (seen.has(pairKey)) continue;

      const reasons: string[] = [];
      let confidence = 0;

      if (a.code && b.code && (a.code as string).toLowerCase() === (b.code as string).toLowerCase()) {
        reasons.push(`Same item code: ${a.code as string}`);
        confidence = 100;
      } else {
        const nameResult = fuzzyMatch(a.description as string, [b.description as string], 0.90);
        if (nameResult) {
          const pct = Math.round(nameResult.score * 100);
          reasons.push(`Name ${pct}% match`);
          confidence = Math.max(confidence, pct);
        }
      }

      if (reasons.length > 0) {
        seen.add(pairKey);
        pairs.push({
          entityType: 'item',
          primary: { id: a.id as string, name: a.description as string, itemCode: a.code, itemType: a.item_type, unit: a.unit, costPrice: a.cost_price },
          duplicate: { id: b.id as string, name: b.description as string, itemCode: b.code, itemType: b.item_type, unit: b.unit, costPrice: b.cost_price },
          confidence,
          matchReasons: reasons,
        });
      }
    }
  }

  log.info('Item duplicate scan complete', { count: pairs.length, companyId }, 'duplicate-detection');
  return pairs;
}

// ── Generic pair-finding ──────────────────────────────────────────────────────

function findDuplicatePairs(
  entities: DuplicateEntity[],
  entityType: 'customer' | 'supplier',
  nameThreshold: number,
): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  const seen = new Set<string>();

  // For >500 entities, bucket by first 3 chars to reduce O(n²) comparisons
  const useBucketing = entities.length > 500;
  const compareGroups: DuplicateEntity[][] = useBucketing
    ? buildBuckets(entities)
    : [entities];

  for (const group of compareGroups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const pairKey = [a.id, b.id].sort().join(':');
        if (seen.has(pairKey)) continue;

        const { reasons, confidence } = scorePair(a, b, nameThreshold);
        if (reasons.length > 0) {
          seen.add(pairKey);
          pairs.push({ entityType, primary: a, duplicate: b, confidence: Math.min(confidence, 100), matchReasons: reasons });
        }
      }
    }
  }

  pairs.sort((a, b) => b.confidence - a.confidence);
  return pairs;
}

function buildBuckets(entities: DuplicateEntity[]): DuplicateEntity[][] {
  const map = new Map<string, DuplicateEntity[]>();
  for (const e of entities) {
    const key = e.name.toLowerCase().slice(0, 3);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  }
  return Array.from(map.values());
}

function scorePair(a: DuplicateEntity, b: DuplicateEntity, nameThreshold: number): { reasons: string[]; confidence: number } {
  const reasons: string[] = [];
  let confidence = 0;

  if (a.vatNumber && b.vatNumber && a.vatNumber === b.vatNumber) {
    reasons.push(`Same VAT number: ${a.vatNumber}`);
    confidence = Math.max(confidence, 95);
  }

  if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) {
    reasons.push(`Same email: ${a.email}`);
    confidence = Math.max(confidence, 90);
  }

  const nameResult = fuzzyMatch(a.name, [b.name], nameThreshold);
  if (nameResult) {
    const pct = Math.round(nameResult.score * 100);
    reasons.push(`Name ${pct}% match`);
    confidence = Math.max(confidence, pct);
  }

  return { reasons, confidence };
}
