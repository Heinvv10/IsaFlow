/**
 * Reserved client_name rule for RFC 7591 dynamic client registration
 * (src/lib/auth/reservedClientName.ts).
 *
 * The name under test is rendered on the OAuth consent screen, so the property
 * that matters is visual: a name a user would read as "IsaFlow" or as
 * officially blessed must be refused, however it is spelled.
 */
import { describe, it, expect } from 'vitest';
import { isReservedClientName, tokenizeForComparison } from '@/lib/auth/reservedClientName';

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
      'Firstparty App',
      'FirstParty Tools',
      'F1rst-P4rty App',
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

  // An unrecognised letter cannot be deleted: that would close the gap between
  // its neighbours and heal the brand into something shorter. It stands in as a
  // single wildcard instead.
  it('refuses the brand with one unrecognised look-alike substituted in', () => {
    for (const name of [
      'isafl\u0585w', // Armenian o
      'isafl\u2C9Fw', // Coptic o
      '\u2C93saflow', // Coptic i
      'isaflo\u13B3', // Cherokee w
      'is\u13AAflow', // Cherokee a
      '\uA4F2saflow', // Lisu i
      'isafl\u10DDw', // Georgian o
      'isafl\u{10404}w', // Deseret o
      'isafl\u{104EA}w', // Osage o
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(true);
    }
  });

  // Only ONE unidentified character is ever tolerated, so each normalisation
  // layer has to be exact rather than leaning on the wildcard. Two substitutions
  // of the same kind are only caught if that layer resolves them properly.
  it('resolves each look-alike class exactly, not by spending the wildcard', () => {
    for (const [name, layer] of [
      ['Isafl\u00f3\u1e83', 'accent decomposition'], // ó and ẃ
      ['is\u200ba\u200bflow', 'invisible removal'], // two zero-width spaces
      ['\u0406saf\u04CFow', 'confusable table'], // Cyrillic І and ӏ
      ['\u0406sa\u0192low', 'NFKD compatibility'], // Cyrillic І and ƒ
    ] as const) {
      expect(isReservedClientName(asHandlerWould(name)), layer).toBe(true);
    }
  });

  // A symbol can stand in for a letter it resembles. A separator is therefore
  // tried both as dropped and as one wildcard.
  it('refuses the brand with a symbol standing in for a letter', () => {
    for (const name of ['!saflow', '|saflow', 'is@flow', 'i$aflow', 'IsaFlovv']) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(true);
    }
    // ...while ordinary trailing punctuation still reads as a separator.
    expect(isReservedClientName(asHandlerWould('Isa Flow!'))).toBe(true);
  });

  // Digits are part of a token, not separators. A digit that stands in for a
  // letter is folded ("1saf1ow"); one that resembles nothing just sits inside
  // the word and keeps it distinct from the brand.
  it('keeps a non-look-alike digit inside the token', () => {
    expect(isReservedClientName(asHandlerWould('isaf2low'))).toBe(false);
    expect(isReservedClientName(asHandlerWould('isaf6low'))).toBe(false);
    expect(isReservedClientName(asHandlerWould('1saf1ow'))).toBe(true);
  });

  // The price of closing the welding bypass: a token that happens to contain the
  // brand is refused even when the registrant meant something else. Measured and
  // accepted — three contrived names against a one-keystroke bypass of the whole
  // control. These registrants can still use the qualified form, "Medisa (IsaFlow)".
  it('refuses a name whose single token happens to contain the brand', () => {
    for (const name of ['Lisaflow', 'Medisaflow', 'Visaflow']) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(true);
    }
  });

  // Documented residual: matching is length-preserving, so it catches a swapped
  // glyph but not an INTERIOR insertion or deletion. Recorded as allowed
  // deliberately — "IsaFllow" folds to "isafiiow" and "Lisa Flow" to "iisafiow",
  // both the brand plus one character, so refusing the first refuses the second.
  it('does not catch an interior insertion or deletion, and says so', () => {
    for (const name of ['IsaFllow', 'IssaFlow', 'IsaaFlow', 'Isafflow', 'IsaFlw', 'IsFlow', 'Vverified Partner']) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(false);
    }
    // ...but an edit at either end leaves the brand intact as a window, so
    // those ARE caught. Within-token matching narrowed this residual.
    for (const name of ['IIsaFlow', 'IsaFloww']) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(true);
    }
  });

  // The brand must be spelled by WHOLE tokens. These merely contain its letters
  // inside longer words and are legitimate names a registrant could hold.
  it('allows names that merely contain the letters of a reserved term', () => {
    for (const name of [
      'Lisa Flow',
      'Visa Flow Tools',
      'Marisa Flowers',
      'Elisa Flow',
      'Luisa Flower Shop',
      'Unofficial Xero Sync',
      'Unverified Test Client',
      'Officiate Pro',
      'Office Ally',
      'Lisa Accounting',
      'Visafone Connector',
      'IsoFlow Diagrammer',
      'CashFlow Tracker',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(false);
    }
  });

  it('refuses a mid-name aside — only a trailing qualifier is exempt', () => {
    expect(isReservedClientName('Acme (isaflow) Connector')).toBe(true);
  });

  // Only the LAST "(...)" is a qualifier, and only when nothing follows it.
  // These shapes each tried to make an earlier bracket look like the trailing
  // one; the brand still lands in the prefix, so they stay refused.
  it('refuses the brand around nested, repeated or multiline brackets', () => {
    for (const name of [
      'Acme (isaflow) Connector (x)',
      'Acme (a(x)b) isaflow (q)',
      'Acme (isaflow)\nbar',
      'x (isaflow)\ny',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(true);
    }
  });

  // Removing a space must not defeat the rule. "OfficialIsaFlow" is
  // "Official IsaFlow" welded together, and before within-token matching it
  // slipped past BOTH reserved classes at once — the cheapest bypass there was,
  // needing nothing but a second attempt after a 400.
  it('refuses a reserved term welded into a longer word', () => {
    for (const name of [
      'OfficialIsaFlow',
      'VerifiedIsaFlow',
      'IsaFlowSupport',
      'GetIsaFlowNow',
      'TheIsaFlow',
      'IsaFlowHQ',
      'GoIsaFlow',
      'MyIsaFlowSync',
      'IsaFlowly',
      'OfficialBot',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(true);
    }
    expect(isReservedClientName(asHandlerWould('MySync (IsaFlow)'))).toBe(false);
  });

  // The brand is a coined word, so it is refused anywhere inside a token. The
  // adjectives are ordinary English that sits inside innocent words, so they
  // are only refused when they LEAD one — otherwise "Unofficial Xero Sync"
  // would be refused for disclaiming exactly what the rule polices.
  it('refuses a leading adjective but not one inside a longer word', () => {
    expect(isReservedClientName(asHandlerWould('Unofficial Xero Sync'))).toBe(false);
    expect(isReservedClientName(asHandlerWould('Unverified Test Client'))).toBe(false);
    expect(isReservedClientName(asHandlerWould('Officiate Pro'))).toBe(false);
    expect(isReservedClientName(asHandlerWould('OfficialSync'))).toBe(true);
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

describe('tokenizeForComparison', () => {
  it('lands every legible spelling of the brand on one token', () => {
    for (const variant of [
      'IsaFlow',
      'Isa Flow',
      'isa-flow',
      'ＩｓａＦｌｏｗ',
      'isa\u200bflow',
      '\u0406saflow',
      '\u{1D4D8}\u{1D4C8}\u{1D4B6}\u{1D4BB}\u{1D4C1}\u2134\u{1D4CC}', // Mathematical Script
      '\u2111\u{1D530}\u{1D51E}\u{1D523}\u{1D529}\u{1D52C}\u{1D534}', // Mathematical Fraktur
    ]) {
      expect(tokenizeForComparison(variant).join(''), variant).toBe(
        tokenizeForComparison('isaflow').join(''),
      );
    }
  });

  it('keeps distinct third-party names distinct', () => {
    const brand = tokenizeForComparison('isaflow').join('');
    for (const name of ['Xero', 'Sage', 'QuickBooks', 'Lisa Flow', 'Medisaflow']) {
      expect(tokenizeForComparison(name).join(''), name).not.toBe(brand);
    }
  });
});
