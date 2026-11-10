/**
 * TENANT PROSE IN CJK KEEPS ITS MATTERS (#1261 round 2, adversarial M1): charging every character the faces do not set
 * the widest fallback glyph (7.25em) in the prose model cut the dense pack's matters page to 5 of its 15 board matters,
 * where master printed 12 and production fitted them (874px of 966). The prose model is master's again (its own PR
 * re-prices it from the faces); this holds the page at master's 12.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { denseInput } from './fixtures/boardPackInputs';

/** The review's Japanese journal description: a payment to a company, March's rent. */
const JAPANESE = '株式会社テストへの支払い、三月分の家賃';

describe('the dense pack with its journal descriptions in Japanese', () => {
  it('prints 12 of its 15 board matters, as master does', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const input = { ...denseInput, matters: denseInput.matters.map((m, n) => ({ ...m, issue: `Journal JE-2026-000${String(n + 61).padStart(2, '0')} (recorded well after its entry date): ${JAPANESE}` })) };
      expect(input.matters.length).toBe(15);
      const doc = buildBoardPackPages(input);
      const printed = doc.pages.flatMap((p) => p.blocks).flatMap((b) => (b.kind === 'matters' ? (b as unknown as { matters: unknown[] }).matters : []));
      expect(printed.length).toBe(12);
    } finally {
      warn.mockRestore();
    }
  });
});
