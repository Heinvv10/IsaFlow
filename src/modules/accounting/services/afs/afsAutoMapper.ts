// src/modules/accounting/services/afs/afsAutoMapper.ts
// Name-pattern heuristics and auto-mapping logic for AFS accounts.
// Depends on afsMappingQueries (for DB reads/writes) and afsTaxonomySeeds
// (for the SUBTYPE_TO_AFS_CODE lookup table). Types come from afsMappingTypes
// so this module never imports back from afsMappingService.

import { log } from '@/lib/logger';
import { getUnmappedAccounts, getStatementLines, mapAccount } from './afsMappingQueries';
import { SUBTYPE_TO_AFS_CODE } from './afsTaxonomySeeds';
import type { AutoMapResult } from './afsMappingTypes';

// ── Name-pattern heuristics ──────────────────────────────────────────────────

// Each pattern names the account types it may map. The name alone was trusted before, so "Shareholders for
// dividend" (a liability) went to IS463 "Dividends received" and "Salaries payable" to IS378: a balance put on an
// income-statement line.
const REV = ['revenue'] as const;
const EXP = ['expense'] as const;
const EQ = ['equity'] as const;
const LIA = ['liability'] as const;
const AST = ['asset'] as const;

const NAME_PATTERNS: Array<{
  pattern: RegExp; code: string; confidence: 'high' | 'medium'; types: readonly string[];
}> = [
  // Revenue
  { pattern: /\b(turnover|sales revenue)\b/i, code: 'IS002', confidence: 'high', types: REV },
  { pattern: /\bmanagement fee/i, code: 'IS013', confidence: 'high', types: REV },
  { pattern: /\brent (received|income)/i, code: 'IS010', confidence: 'high', types: REV },
  // Cost of sales
  { pattern: /\bcost of (sales|goods)/i, code: 'IS042', confidence: 'high', types: EXP },
  { pattern: /\bsub.?contract/i, code: 'IS109', confidence: 'medium', types: EXP },
  // Expenses
  { pattern: /\baccounting (fee|officer)/i, code: 'IS160', confidence: 'high', types: EXP },
  { pattern: /\bauditor/i, code: 'IS171', confidence: 'high', types: EXP },
  { pattern: /\bbank charge/i, code: 'IS183', confidence: 'high', types: EXP },
  { pattern: /\bclean(ing|er)/i, code: 'IS195', confidence: 'medium', types: EXP },
  { pattern: /\bcomputer|internet/i, code: 'IS201', confidence: 'medium', types: EXP },
  { pattern: /\bconsultant|professional fee/i, code: 'IS204', confidence: 'medium', types: EXP },
  { pattern: /\bdepreciation/i, code: 'IS219', confidence: 'high', types: EXP },
  { pattern: /\bdirector.*remuneration/i, code: 'IS225', confidence: 'high', types: EXP },
  { pattern: /\bdonation/i, code: 'IS234', confidence: 'medium', types: EXP },
  { pattern: /\bentertain/i, code: 'IS240', confidence: 'medium', types: EXP },
  { pattern: /\binsurance/i, code: 'IS258', confidence: 'medium', types: EXP },
  { pattern: /\blegal fee/i, code: 'IS279', confidence: 'medium', types: EXP },
  { pattern: /\bmember.*remuneration/i, code: 'IS291', confidence: 'high', types: EXP },
  { pattern: /\bmotor vehicle/i, code: 'IS297', confidence: 'medium', types: EXP },
  { pattern: /\brent paid/i, code: 'IS351', confidence: 'high', types: EXP },
  { pattern: /\brepair.*maintenance/i, code: 'IS360', confidence: 'medium', types: EXP },
  { pattern: /\bsalar(y|ies)|wages|labour/i, code: 'IS378', confidence: 'high', types: EXP },
  { pattern: /\bsecurity/i, code: 'IS381', confidence: 'medium', types: EXP },
  { pattern: /\bstaff (welfare|training)/i, code: 'IS393', confidence: 'medium', types: EXP },
  { pattern: /\bstation(e|a)ry|printing/i, code: 'IS330', confidence: 'medium', types: EXP },
  { pattern: /\bsubscription|lev(y|ies)/i, code: 'IS398', confidence: 'medium', types: EXP },
  { pattern: /\btelephone/i, code: 'IS401', confidence: 'medium', types: EXP },
  { pattern: /\btravel|accomm?odation/i, code: 'IS422', confidence: 'medium', types: EXP },
  { pattern: /\bwater|electric/i, code: 'IS443', confidence: 'medium', types: EXP },
  { pattern: /\binterest paid/i, code: 'IS454', confidence: 'high', types: EXP },
  { pattern: /\binterest (received|earned)/i, code: 'IS461', confidence: 'high', types: REV },
  { pattern: /\bdividend/i, code: 'IS463', confidence: 'high', types: REV },
  // An equity "Dividends declared / paid" account: IS484, carried into equity (primaryStatements/dividendsPaid.ts).
  { pattern: /\bdividend/i, code: 'IS484', confidence: 'high', types: EQ },
  // Balance sheet
  { pattern: /\bshar(e|eholder).*capital/i, code: 'BS043', confidence: 'high', types: EQ },
  { pattern: /\bretained (earnings|income|profit)/i, code: 'BS045', confidence: 'high', types: EQ },
  { pattern: /\bshareholder.*loan/i, code: 'BS053', confidence: 'high', types: LIA },
  { pattern: /\bmember.*loan/i, code: 'BS055', confidence: 'high', types: LIA },
  { pattern: /\btrade.*receivable/i, code: 'BS028', confidence: 'high', types: AST },
  { pattern: /\btrade.*payable/i, code: 'BS065', confidence: 'high', types: LIA },
  { pattern: /\bprepayment|prepaid/i, code: 'BS031', confidence: 'medium', types: AST },
  { pattern: /\binventor/i, code: 'BS026', confidence: 'high', types: AST },
  { pattern: /\bbank.*overdraft/i, code: 'BS070', confidence: 'high', types: LIA },
  { pattern: /\btax(ation)? (payable|liability)/i, code: 'BS069', confidence: 'high', types: LIA },
  { pattern: /\btax(ation)? (receivable|asset)/i, code: 'BS032', confidence: 'high', types: AST },
  { pattern: /\baccrued expense/i, code: 'BS066', confidence: 'medium', types: LIA },
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
      for (const { pattern, code, confidence, types } of NAME_PATTERNS) {
        if (types.includes(acct.accountType) && pattern.test(acct.accountName) && validCodes.has(code)) {
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
