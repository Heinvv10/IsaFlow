/**
 * VLM Bank Match Service — Enhanced bank reconciliation matching via VLM.
 * Pure business logic — no database dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedBankDescription {
  vendorName: string | null;
  customerName: string | null;
  invoiceRef: string | null;
  paymentType: string | null;
}

export interface VlmMatchResult {
  entityId: string;
  entityName: string;
  entityType: 'supplier' | 'customer';
  score: number;
}

export interface OutstandingInvoice {
  id: string;
  entityId: string;
  amount: number;
  reference: string;
  date: string;
}

export interface EnhancedMatchCandidate {
  invoiceId: string;
  confidence: number;
  matchMethod: 'vlm_amount' | 'vlm_reference';
}

interface MatchEntity {
  id: string;
  name: string;
}

interface BankTxInput {
  id: string;
  amount: number;
  date: string;
  reference: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STRIP = /\s*\(?(pty|ltd|limited|inc|cc|soc|npc)\)?\s*/gi;

function norm(s: string): string {
  return s.toLowerCase().replace(STRIP, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bA = new Set<string>();
  const bB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bA.add(a.substring(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bB.add(b.substring(i, i + 2));
  let inter = 0;
  for (const bg of bA) if (bB.has(bg)) inter++;
  return (2 * inter) / (bA.size + bB.size);
}

function matchEntity(name: string, entities: MatchEntity[]): { entity: MatchEntity; score: number } | null {
  const normName = norm(name);
  if (!normName) return null;

  let best: { entity: MatchEntity; score: number } | null = null;

  for (const e of entities) {
    const normE = norm(e.name);
    if (!normE) continue;

    if (normName === normE) return { entity: e, score: 1.0 };

    if (normName.includes(normE) || normE.includes(normName)) {
      const score = 0.7 + (Math.min(normName.length, normE.length) / Math.max(normName.length, normE.length)) * 0.3;
      if (!best || score > best.score) best = { entity: e, score };
      continue;
    }

    const score = dice(normName, normE);
    if (score >= 0.5 && (!best || score > best.score)) best = { entity: e, score };
  }

  return best;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseBankDescriptionResponse(response: string): ParsedBankDescription | null {
  let jsonStr = response.trim();

  // Strip <think> tags
  if (jsonStr.includes('<think>')) {
    jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  }
  // Strip markdown fences
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  // Extract JSON
  const match = jsonStr.match(/\{[\s\S]*\}/);
  if (match) jsonStr = match[0];

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      vendorName: typeof parsed.vendorName === 'string' ? parsed.vendorName : null,
      customerName: typeof parsed.customerName === 'string' ? parsed.customerName : null,
      invoiceRef: typeof parsed.invoiceRef === 'string' ? parsed.invoiceRef : null,
      paymentType: typeof parsed.paymentType === 'string' ? parsed.paymentType : null,
    };
  } catch {
    return null;
  }
}

export function enhanceMatchWithVlm(
  parsed: ParsedBankDescription,
  suppliers: MatchEntity[],
  clients: MatchEntity[],
): VlmMatchResult | null {
  // Try supplier match first
  if (parsed.vendorName) {
    const result = matchEntity(parsed.vendorName, suppliers);
    if (result) {
      return { entityId: result.entity.id, entityName: result.entity.name, entityType: 'supplier', score: Math.round(result.score * 100) / 100 };
    }
  }

  // Try customer match
  if (parsed.customerName) {
    const result = matchEntity(parsed.customerName, clients);
    if (result) {
      return { entityId: result.entity.id, entityName: result.entity.name, entityType: 'customer', score: Math.round(result.score * 100) / 100 };
    }
  }

  return null;
}

export function buildEnhancedMatchCandidates(
  bankTx: BankTxInput,
  vlmResult: VlmMatchResult,
  outstandingInvoices: OutstandingInvoice[],
): EnhancedMatchCandidate[] {
  const absAmount = Math.abs(bankTx.amount);
  const entityInvoices = outstandingInvoices.filter(inv => inv.entityId === vlmResult.entityId);

  const candidates: EnhancedMatchCandidate[] = [];

  // Reference match (highest confidence)
  if (bankTx.reference) {
    const refMatch = entityInvoices.find(inv =>
      inv.reference && inv.reference.toLowerCase().includes(bankTx.reference.toLowerCase())
    );
    if (refMatch) {
      candidates.push({ invoiceId: refMatch.id, confidence: 0.95, matchMethod: 'vlm_reference' });
    }
  }

  // Amount match for this entity
  const amountMatches = entityInvoices.filter(inv => Math.abs(inv.amount - absAmount) < 0.02);
  for (const inv of amountMatches) {
    if (!candidates.some(c => c.invoiceId === inv.id)) {
      candidates.push({ invoiceId: inv.id, confidence: Math.round(vlmResult.score * 0.95 * 100) / 100, matchMethod: 'vlm_amount' });
    }
  }

  return candidates;
}
