/**
 * Reserved client_name rule for RFC 7591 dynamic client registration
 * (src/lib/auth/reservedClientName.ts).
 *
 * The name under test is rendered on the OAuth consent screen, so the property
 * that matters is visual: a name a user would read as "IsaFlow" or as
 * officially blessed must be refused, however it is spelled.
 */
import { describe, it, expect } from 'vitest';
import { isReservedClientName, foldForComparison } from '@/lib/auth/reservedClientName';

/** The handler trims and truncates before checking; mirror that here. */
const asHandlerWould = (raw: string) => raw.trim().slice(0, 80);

describe('isReservedClientName', () => {
  it('refuses the brand as the subject of the name', () => {
    for (const name of [
      'IsaFlow',
      'isaflow',
      'IsaFlow Connector',
      'isaflow support',
      'The IsaFlow App',
      'Get IsaFlow Free',
      'IsaFlow (Claude Code)',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(true);
    }
  });

  it('refuses reserved adjectives wherever they appear, including in a qualifier', () => {
    for (const name of [
      'Verified Partner',
      'First-Party App',
      'First Party App',
      'Claude Code (Official)',
      'Acme Bot (verified)',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(true);
    }
  });

  it('allows a client that names the service it connects to in a trailing qualifier', () => {
    for (const name of [
      'Claude Code (isaflow)',
      'Claude Code (IsaFlow MCP)',
      'Acme Bookkeeping Bot (IsaFlow)',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(false);
    }
  });

  it('allows ordinary third-party client names', () => {
    for (const name of [
      'Acme Bookkeeping Bot',
      'Acme Billing Bot',
      'Support Desk Connector',
      'Xero',
      'QuickBooks Sync',
      'Sage Connector',
      'Zapier',
      'Receipt Bank',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(false);
    }
  });

  // A qualifier qualifies something. If nothing legible precedes it, the name
  // renders as the brand alone — "​(IsaFlow)" shows as "(IsaFlow)".
  it('refuses a qualifier with no legible client name in front of it', () => {
    for (const name of [
      '(isaflow)',
      '​(isaflow)', // zero-width space
      '‌(IsaFlow)', // zero-width non-joiner
      '⁠(IsaFlow)', // word joiner
      '. (isaflow)',
      '- (isaflow)',
      '_ (IsaFlow)',
      '* (IsaFlow)',
      '1 (IsaFlow)',
      'A (IsaFlow)', // one letter names nothing
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(true);
    }
  });

  it('refuses a mid-name aside — only a trailing qualifier is exempt', () => {
    expect(isReservedClientName('Acme (isaflow) Connector')).toBe(true);
  });

  // These render as the brand to a user but are not the literal ASCII string.
  it('refuses visually-identical spellings of the brand', () => {
    for (const name of [
      'Isa Flow',
      'isa-flow',
      'Isa_Flow',
      'I.s.a.F.l.o.w',
      'isa​flow', // zero-width space inside the word
      'isa­flow', // soft hyphen
      'Іsaflow', // Cyrillic І
      'ISАFLOW', // Cyrillic А
      'ＩｓａＦｌｏｗ', // full-width
      '1saf1ow', // digit look-alikes
      'Isafl\u00f3w', // precomposed accent
      'Isaflo\u0301w', // combining accent
      '\u0131saflow', // dotless i
      'ISAFLOW',
      'IsaFlow​',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(true);
    }
  });

  // Truncation happens before the check, so the check and the consent screen
  // read the same string. A cut that removes the closing paren must fail closed.
  it('fails closed when truncation cuts the qualifier', () => {
    const cut = asHandlerWould(`Claude Code (isaflow ${'x'.repeat(80)})`);
    expect(cut.length).toBe(80);
    expect(cut.endsWith(')')).toBe(false);
    expect(isReservedClientName(cut)).toBe(true);
  });

  it('is linear on adversarial input at the length bound', () => {
    const started = Date.now();
    for (let i = 0; i < 20_000; i += 1) {
      isReservedClientName(`${'('.repeat(40)}${')'.repeat(39)}isaflow`.slice(0, 80));
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('foldForComparison', () => {
  it('lands every spelling of the brand on one string', () => {
    const canonical = foldForComparison('isaflow');
    for (const variant of ['IsaFlow', 'Isa Flow', 'isa-flow', 'ＩｓａＦｌｏｗ', 'isa​flow', 'Іsaflow']) {
      expect(foldForComparison(variant), variant).toBe(canonical);
    }
  });

  it('does not collapse distinct third-party names onto the brand', () => {
    const canonical = foldForComparison('isaflow');
    for (const name of ['Xero', 'Sage', 'QuickBooks', 'Acme Bookkeeping Bot']) {
      expect(foldForComparison(name), name).not.toBe(canonical);
    }
  });
});
