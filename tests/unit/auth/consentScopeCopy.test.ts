/**
 * The two scope-copy tables must not drift.
 *
 * PAT_SCOPE_META drives the personal-access-token page; SCOPE_LABELS in
 * ConsentScopeList drives the OAuth authorize screen — which is the surface an
 * MCP connector actually shows someone before they grant it. They were updated
 * independently once already: a change describing credit notes landed in the
 * PAT table only, so the consent screen kept telling users a token could
 * "create and edit invoices" while it could also reduce their receivables.
 *
 * This does not assert the two strings are equal — the surfaces have different
 * lengths and voices. It asserts they agree about WHAT THE GRANT PERMITS, by
 * requiring the same load-bearing nouns in both.
 */
import { describe, it, expect } from 'vitest';
import { PAT_SCOPE_META } from '@/lib/auth/patScopeMeta';
import { PAT_SCOPES } from '@/lib/auth/patScopes';
import { SCOPE_LABELS } from '@/lib/auth/consentScopeLabels';

/** Concepts that must appear in both tables for a given scope. */
const MUST_MENTION: Partial<Record<string, string[]>> = {
  'write:invoices': ['invoice', 'credit note'],
  'read:invoices': ['invoice'],
  'write:post': ['journal', 'revers'],
  'write:bank-tx': ['bank'],
  'write:accounts': ['account'],
  'read:bank-tx': ['bank'],
  'read:reports': ['report'],
  'read:contacts': ['customer'],
  'read:vat': ['vat'],
};

describe('scope copy — PAT page and OAuth consent screen agree', () => {
  it('every PAT scope has consent-screen copy', () => {
    for (const scope of PAT_SCOPES) {
      expect(SCOPE_LABELS[scope], `no consent label for ${scope}`).toBeTruthy();
    }
  });

  it('both tables name the same permissions', () => {
    for (const [scope, needles] of Object.entries(MUST_MENTION)) {
      const pat = `${PAT_SCOPE_META[scope as keyof typeof PAT_SCOPE_META]?.label ?? ''} ${
        PAT_SCOPE_META[scope as keyof typeof PAT_SCOPE_META]?.desc ?? ''}`.toLowerCase();
      const consent = (SCOPE_LABELS[scope] ?? '').toLowerCase();
      for (const needle of needles!) {
        expect(pat, `PAT copy for ${scope} omits "${needle}"`).toContain(needle);
        expect(consent, `consent copy for ${scope} omits "${needle}"`).toContain(needle);
      }
    }
  });

  it('consent labels stay short enough to read in a list', () => {
    for (const [scope, text] of Object.entries(SCOPE_LABELS)) {
      expect(text.length, `${scope} consent label is ${text.length} chars`).toBeLessThanOrEqual(120);
    }
  });

  it('PAT descriptions stay within a readable length', () => {
    for (const scope of PAT_SCOPES) {
      const desc = PAT_SCOPE_META[scope]?.desc ?? '';
      expect(desc.length, `${scope} PAT desc is ${desc.length} chars`).toBeLessThanOrEqual(340);
    }
  });
});
