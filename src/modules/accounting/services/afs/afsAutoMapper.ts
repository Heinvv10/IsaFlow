// src/modules/accounting/services/afs/afsAutoMapper.ts
// Name-pattern heuristics and auto-mapping logic for AFS accounts.
// Depends on afsMappingService (for DB reads/writes) and afsTaxonomySeeds
// (for the SUBTYPE_TO_AFS_CODE lookup table).

import { log } from '@/lib/logger';
import { getUnmappedAccounts, getStatementLines, mapAccount } from './afsMappingService';
import { SUBTYPE_TO_AFS_CODE } from './afsTaxonomySeeds';
import type { AutoMapResult } from './afsMappingService';

// ── Name-pattern heuristics ──────────────────────────────────────────────────

const NAME_PATTERNS: Array<{ pattern: RegExp; code: string; confidence: 'high' | 'medium' }> = [
  // Revenue
  { pattern: /\b(turnover|sales revenue)\b/i, code: 'IS002', confidence: 'high' },
  { pattern: /\bmanagement fee/i, code: 'IS013', confidence: 'high' },
  { pattern: /\brent (received|income)/i, code: 'IS010', confidence: 'high' },
  // Cost of sales
  { pattern: /\bcost of (sales|goods)/i, code: 'IS042', confidence: 'high' },
  { pattern: /\bsub.?contract/i, code: 'IS109', confidence: 'medium' },
  // Expenses
  { pattern: /\baccounting (fee|officer)/i, code: 'IS160', confidence: 'high' },
  { pattern: /\bauditor/i, code: 'IS171', confidence: 'high' },
  { pattern: /\bbank charge/i, code: 'IS183', confidence: 'high' },
  { pattern: /\bclean(ing|er)/i, code: 'IS195', confidence: 'medium' },
  { pattern: /\bcomputer|internet/i, code: 'IS201', confidence: 'medium' },
  { pattern: /\bconsultant|professional fee/i, code: 'IS204', confidence: 'medium' },
  { pattern: /\bdepreciation/i, code: 'IS219', confidence: 'high' },
  { pattern: /\bdirector.*remuneration/i, code: 'IS225', confidence: 'high' },
  { pattern: /\bdonation/i, code: 'IS234', confidence: 'medium' },
  { pattern: /\bentertain/i, code: 'IS240', confidence: 'medium' },
  { pattern: /\binsurance/i, code: 'IS258', confidence: 'medium' },
  { pattern: /\blegal fee/i, code: 'IS279', confidence: 'medium' },
  { pattern: /\bmember.*remuneration/i, code: 'IS291', confidence: 'high' },
  { pattern: /\bmotor vehicle/i, code: 'IS297', confidence: 'medium' },
  { pattern: /\brent paid/i, code: 'IS351', confidence: 'high' },
  { pattern: /\brepair.*maintenance/i, code: 'IS360', confidence: 'medium' },
  { pattern: /\bsalar(y|ies)|wages|labour/i, code: 'IS378', confidence: 'high' },
  { pattern: /\bsecurity/i, code: 'IS381', confidence: 'medium' },
  { pattern: /\bstaff (welfare|training)/i, code: 'IS393', confidence: 'medium' },
  { pattern: /\bstation(e|a)ry|printing/i, code: 'IS330', confidence: 'medium' },
  { pattern: /\bsubscription|lev(y|ies)/i, code: 'IS398', confidence: 'medium' },
  { pattern: /\btelephone/i, code: 'IS401', confidence: 'medium' },
  { pattern: /\btravel|accomm?odation/i, code: 'IS422', confidence: 'medium' },
  { pattern: /\bwater|electric/i, code: 'IS443', confidence: 'medium' },
  { pattern: /\binterest paid/i, code: 'IS454', confidence: 'high' },
  { pattern: /\binterest (received|earned)/i, code: 'IS461', confidence: 'high' },
  { pattern: /\bdividend/i, code: 'IS463', confidence: 'high' },
  // Balance sheet
  { pattern: /\bshar(e|eholder).*capital/i, code: 'BS043', confidence: 'high' },
  { pattern: /\bretained (earnings|income|profit)/i, code: 'BS045', confidence: 'high' },
  { pattern: /\bshareholder.*loan/i, code: 'BS053', confidence: 'high' },
  { pattern: /\bmember.*loan/i, code: 'BS055', confidence: 'high' },
  { pattern: /\btrade.*receivable/i, code: 'BS028', confidence: 'high' },
  { pattern: /\btrade.*payable/i, code: 'BS065', confidence: 'high' },
  { pattern: /\bprepayment|prepaid/i, code: 'BS031', confidence: 'medium' },
  { pattern: /\binventor/i, code: 'BS026', confidence: 'high' },
  { pattern: /\bbank.*overdraft/i, code: 'BS070', confidence: 'high' },
  { pattern: /\btax(ation)? (payable|liability)/i, code: 'BS069', confidence: 'high' },
  { pattern: /\btax(ation)? (receivable|asset)/i, code: 'BS032', confidence: 'high' },
  { pattern: /\baccrued expense/i, code: 'BS066', confidence: 'medium' },
];

// ── Auto-mapping orchestrator ────────────────────────────────────────────────

export async function autoMapAccounts(companyId: string): Promise<AutoMapResult> {
  const unmapped = await getUnmappedAccounts(companyId);
  const existingLines = await getStatementLines(companyId);
  const validCodes = new Set(existingLines.map((l) => l.code));

  const result: AutoMapResult = { mapped: 0, skipped: 0, suggestions: [] };

  for (const acct of unmapped) {
    let bestCode: string | null = null;
    let bestConfidence: 'high' | 'medium' | 'low' = 'low';
    let bestLabel = '';

    // Priority 1: subtype match
    const subtypeCode = acct.accountSubtype ? SUBTYPE_TO_AFS_CODE[acct.accountSubtype] : undefined;
    if (subtypeCode && validCodes.has(subtypeCode)) {
      bestCode = subtypeCode;
      bestConfidence = 'high';
      bestLabel = existingLines.find((l) => l.code === subtypeCode)?.label ?? subtypeCode;
    }

    // Priority 2: name pattern match (only upgrade, never downgrade)
    if (bestConfidence !== 'high') {
      for (const { pattern, code, confidence } of NAME_PATTERNS) {
        if (pattern.test(acct.accountName) && validCodes.has(code)) {
          if (confidence === 'high' || bestConfidence === 'low') {
            bestCode = code;
            bestConfidence = confidence;
            bestLabel = existingLines.find((l) => l.code === code)?.label ?? code;
          }
          if (bestConfidence === 'high') break;
        }
      }
    }

    if (bestCode && bestConfidence === 'high') {
      await mapAccount(companyId, acct.id, bestCode);
      result.mapped++;
    } else if (bestCode) {
      result.suggestions.push({
        glAccountId: acct.id,
        accountCode: acct.accountCode,
        accountName: acct.accountName,
        suggestedCode: bestCode,
        suggestedLabel: bestLabel,
        confidence: bestConfidence,
      });
    } else {
      result.skipped++;
    }
  }

  log.info('afsAutoMapper.autoMapAccounts', {
    companyId,
    mapped: result.mapped,
    suggestions: result.suggestions.length,
    skipped: result.skipped,
  });

  return result;
}
