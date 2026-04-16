// src/modules/accounting/services/afs/noteAiService.ts
import Anthropic from '@anthropic-ai/sdk';
import { log } from '@/lib/logger';
import type { NoteContent, SectionType, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';

export interface CompanyContext {
  name: string;
  framework: ReportingFramework;
  fiscalYear: number;
}

const client = new Anthropic();

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

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0]?.type === 'text' ? response.content[0].text : '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('AI narrative generation failed', { sectionType, companyName: companyContext.name, error: message }, 'noteAiService');
    throw new Error(`AI narrative generation failed: ${message}`);
  }
}
