/**
 * Adversarial (PR #1145 fix 2): the accepted-narrative dedupe in packSectionView. The accept route
 * (pages/api/accounting/afs/[documentId]/sections/[sectionId]/ai-narrative.ts, handleAccept) writes
 * overrides = { title: content.title, blocks: [...content.blocks, { paragraph: ai_narrative }] } and sets ai_narrative_accepted;
 * ai_narrative itself stays. Every `it` asserts the correct print, so red is the finding.
 */
import { describe, expect, it } from 'vitest';
import { renderPackSectionContent } from '@/modules/accounting/services/afs/afsHtmlTableRenderer';
import type { AfsSection } from '@/modules/accounting/services/afs/afsTypes';

/** What handleAccept stores, from a section's content and narrative. */
const accept = (content: { title: string; blocks: unknown[] }, narrative: string) =>
  ({ title: content.title ?? '', blocks: [...content.blocks, { type: 'paragraph', text: narrative }] });
const sec = (sectionType: string, content: { title: string; blocks: unknown[] }, overrides: unknown, aiNarrative: string | null) =>
  ({ id: 's', sectionType, sortOrder: 0, content, overrides, aiNarrative, aiNarrativeAccepted: overrides !== null } as unknown as AfsSection);

const STATEMENT = { type: 'table', headers: ['', 'This month'], rows: [['Net profit', 'R 4.00']], rowKinds: ['total'] };

describe('accepted narrative prints once', () => {
  it('control: accepted and untouched prints once', () => {
    const c = { title: 'Income Statement', blocks: [STATEMENT] };
    const h = renderPackSectionContent(sec('income_statement', c, accept(c, 'Revenue was R9.'), 'Revenue was R9.'));
    expect(h.split('Revenue was R9.').length - 1).toBe(1);
  });

  it('an accepted narrative the accountant then EDITED (overrides PUT) does not bring the unedited AI text back', () => {
    const c = { title: 'Income Statement', blocks: [STATEMENT] };
    const edited = { title: 'Income Statement', blocks: [STATEMENT, { type: 'paragraph', text: 'Revenue was R10 (corrected).' }] };
    const h = renderPackSectionContent(sec('income_statement', c, edited, 'Revenue was R9.'));
    expect(h).toContain('Revenue was R10 (corrected).');
    expect(h).not.toContain('Revenue was R9.');
  });

  it('an accepted narrative the accountant then DELETED does not come back', () => {
    const c = { title: 'Income Statement', blocks: [STATEMENT] };
    const h = renderPackSectionContent(sec('income_statement', c, { title: 'Income Statement', blocks: [STATEMENT] }, 'Revenue was R9.'));
    expect(h).not.toContain('Revenue was R9.');
  });
});

describe('accepting on an older pack (dev 2026-10 pack shape)', () => {
  it('keeps the vocabulary title: accept copies the bare key content.title into overrides.title', () => {
    const c = { title: 'cash_flow', blocks: [] };
    const h = renderPackSectionContent(sec('cash_flow', c, accept(c, 'Cash held.'), 'Cash held.'));
    expect(h).toMatch(/<h2>Cash Flow<\/h2>/);
  });
  it('never prints an AI failure sentence that accept froze into the blocks', () => {
    const c = { title: 'cash_flow', blocks: [] };
    const placeholder = 'AI commentary unavailable for this section.';
    const h = renderPackSectionContent(sec('cash_flow', c, accept(c, placeholder), placeholder));
    expect(h).not.toContain(placeholder);
  });
});
