import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return {
    default: MockAnthropic,
    __mockCreate: mockCreate,
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { generateNoteNarrative } from '@/modules/accounting/services/afs/noteAiService';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';

const CONTENT: NoteContent = {
  title: 'PPE',
  blocks: [
    { type: 'paragraph', text: 'Intro text.' },
    { type: 'table', headers: ['Category', 'Amount'], rows: [['Vehicles', '100,000.00']] },
  ],
};

const CONTEXT = { name: 'Test Co', framework: 'ifrs_smes' as const, fiscalYear: 2025 };

async function getCreateMock() {
  const mod = await import('@anthropic-ai/sdk') as { __mockCreate: ReturnType<typeof vi.fn> };
  return mod.__mockCreate;
}

describe('noteAiService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns narrative text on success', async () => {
    const mockCreate = await getCreateMock();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Generated narrative.' }],
    });

    const result = await generateNoteNarrative('note_3', CONTENT, 'Summarise {sectionType} for {companyName} in {fiscalYear}.', CONTEXT);
    expect(result).toBe('Generated narrative.');
  });

  it('replaces all template placeholders', async () => {
    const mockCreate = await getCreateMock();
    let capturedPrompt = '';
    mockCreate.mockImplementationOnce(async (opts: { messages: { content: string }[] }) => {
      capturedPrompt = opts.messages[0]!.content;
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    await generateNoteNarrative(
      'note_3',
      CONTENT,
      'Type:{sectionType} Co:{companyName} Year:{fiscalYear} FW:{framework} Tables:{tables}',
      CONTEXT,
    );

    expect(capturedPrompt).toContain('Type:note_3');
    expect(capturedPrompt).toContain('Co:Test Co');
    expect(capturedPrompt).toContain('Year:2025');
    expect(capturedPrompt).toContain('FW:ifrs_smes');
    expect(capturedPrompt).toContain('"type":"table"');
  });

  it('returns empty string when API returns no text content', async () => {
    const mockCreate = await getCreateMock();
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'x' }] });
    const result = await generateNoteNarrative('note_1', CONTENT, 'template', CONTEXT);
    expect(result).toBe('');
  });

  it('throws with descriptive message on API failure', async () => {
    const mockCreate = await getCreateMock();
    mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));
    await expect(
      generateNoteNarrative('note_1', CONTENT, 'template', CONTEXT),
    ).rejects.toThrow('AI narrative generation failed: API rate limit exceeded');
  });
});
