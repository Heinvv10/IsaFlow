// src/modules/accounting/services/afs/noteAiService.ts
import Anthropic from '@anthropic-ai/sdk';
import { log } from '@/lib/logger';
import { markAnthropicUsedUnlessNoWork, markQuotaUsed } from '@/lib/quotaUse';
import type { NoteContent, SectionType, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';

export interface CompanyContext {
  name: string;
  framework: ReportingFramework;
  fiscalYear: number;
}

// No SDK retries (its default is 2, on 408/409/429/5xx/529). An attempt that did
// the work followed by a final 529 would otherwise be judged by the 529 alone
// and the daily AI unit given back (R-175), and the SDK's errors do not say
// whether a retry happened. The one caller (the AFS section ai-narrative route)
// reports the failure and the user can try again.
// The route runs under withAuth, so the call holds a pool connection and is bounded (R-188). The
// SDK's default timeout is 600 s, and its `timeout` option stops at the response headers, so the
// call also takes a per-call AbortSignal.timeout covering the body read. 60 s: Sonnet at
// max_tokens 1024 can take tens of seconds, and it is still well under 600 s.
export const NOTE_AI_TIMEOUT_MS = 60_000;
const client = new Anthropic({ maxRetries: 0, timeout: NOTE_AI_TIMEOUT_MS });

export async function generateNoteNarrative(
  sectionType: SectionType,
  content: NoteContent,
  promptTemplate: string,
  companyContext: CompanyContext,
): Promise<string> {
  const prompt = promptTemplate
    .replace('{tables}', JSON.stringify(content.blocks.filter(b => b.type === 'table')))
    .replace('{companyName}', companyContext.name)
    .replace('{fiscalYear}', String(companyContext.fiscalYear))
    .replace('{framework}', companyContext.framework)
    .replace('{sectionType}', sectionType);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), NOTE_AI_TIMEOUT_MS);
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }, { signal: abort.signal });
    // The provider answered: the request's daily AI unit is spent (R-175).
    markQuotaUsed('ai');

    return response.content[0]?.type === 'text' ? response.content[0].text : '';
  } catch (err) {
    markAnthropicUsedUnlessNoWork(err);
    const message = err instanceof Error ? err.message : String(err);
    log.error('AI narrative generation failed', { sectionType, companyName: companyContext.name, error: message }, 'noteAiService');
    throw new Error(`AI narrative generation failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
