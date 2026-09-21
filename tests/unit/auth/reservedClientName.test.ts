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

  // Both classes match anywhere in a token, because restricting either to the
  // start leaves the same one-keystroke bypass mirrored: "OfficialIsaFlow" for
  // the brand, "ClaudeCodeOfficial" for the adjectives.
  it('refuses an adjective wherever it appears in a token', () => {
    for (const name of ['OfficialSync', 'XeroOfficial', 'AcmeVerified', 'ClaudeCodeOfficial', 'AcmeFirstParty']) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(true);
    }
  });

  // ...except directly behind a negating morpheme, which makes it a denial
  // rather than a claim. Without this, refusing an adjective anywhere would
  // refuse the names that disclaim exactly what the rule polices.
  it('allows an adjective that a negation turns into a denial', () => {
    for (const name of [
      'Unofficial Xero Sync',
      'UnofficialXeroSync',
      'Unverified Test Client',
      'Nonofficial Tool',
      'NotOfficial App',
      'Officiate Pro',
      'Office Ally',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(false);
    }
  });

  // The negation must BE the start of the token. Checking only what sits in
  // front of the term let any word ending in "un", "non" or "not" shelter it —
  // each of these reads as a claim, and is one deleted space from a refusal.
  it('does not let a word that merely ends in un/non/not shelter a term', () => {
    for (const name of ['CanonOfficial', 'CanonVerified', 'SunOfficial', 'XenonOfficial', 'RunVerified', 'KnotVerified', 'CanonFirstParty']) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(true);
    }
    // A negation shelters only the term directly behind it. A second copy
    // further along the same token is still a claim.
    expect(isReservedClientName(asHandlerWould('UnofficialOfficial'))).toBe(true);
  });

  // The shelter is a privilege, so it is granted only for a negation written in
  // plain letters. NFKD folds superscripts into ordinary letters, so these
  // tokenize as "unofficial" while rendering as "Official" with a smudge.
  it('does not let a near-invisible negation shelter a term', () => {
    for (const name of [
      '\u1D58\u207FOfficial', // superscript un
      '\u1D64\u2099Official', // subscript un
      '\u1D58\u207FVerified Partner',
      '\u207F\u1D52\u207FOfficial', // superscript non
      '\u207F\u00BA\u207FOfficial', // superscript n with the ordinal o — the n's still gate it
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(true);
    }
  });

  // The plain confirmation is bound to the token it vouches for. One visible
  // "Unofficial" must not lend its shelter to a disguised "Official" beside it.
  it('does not let one plain negation shelter a disguised one elsewhere', () => {
    expect(isReservedClientName(asHandlerWould('Unofficial \u1D58\u207FOfficial'))).toBe(true);
    // ...while two plain negations each shelter their own token.
    expect(isReservedClientName(asHandlerWould('Unofficial Unofficial Sync'))).toBe(false);
  });

  // A legitimate disclaimer keeps its shelter even when the disclaimer word
  // itself carries a ligature, symbol or decoration. The first of these is what
  // "Unofficial" becomes when pasted from a PDF, which renders "ffi" as one
  // glyph — the realistic case that decided the whole-name design over a
  // per-token one, which refused all of these.
  it('keeps the shelter for a decorated but visible disclaimer', () => {
    for (const name of [
      'Uno\uFB03cial Sync', // ffi ligature
      'Unof\uFB01cial Sync', // fi ligature
      'Unofficial\u2122 Sync', // trademark sign welded on
      '\uFF35\uFF4E\uFF4F\uFF46\uFF46\uFF49\uFF43\uFF49\uFF41\uFF4C', // fullwidth
      'Unoffici\u00e1l Sync', // accented
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(false);
    }
  });

  // The gate counts only modifier letters NFKD REWRITES. The Japanese long-vowel
  // and iteration marks are modifier letters that NFKD leaves alone; gating on
  // them would strip the shelter from ordinary Japanese names.
  it('does not withhold the shelter for modifiers NFKD leaves alone', () => {
    for (const name of ['Unofficial \u30B3\u30FC\u30D2\u30FC', 'Unofficial \u4F50\u3005\u6728 Accounting']) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(false);
    }
  });

  // The measured cost of withholding the shelter for the whole name: a
  // disclaimer that shares its name with a superscript letter elsewhere is
  // refused. Rarer than the cost of the per-token design it replaced, and
  // fail-closed. Recorded so a future loosening is a decision, not a bug fix.
  it('withholds the shelter when the name also carries a superscript letter', () => {
    for (const name of ['Unofficial M\u1D9C Books', 'Unofficial Studio\u1D2C Books', 'Unverified M\u1D9CKenzie Ledger']) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(true);
    }
  });

  // An unidentified letter stays inside the token as a wildcard rather than
  // splitting it. As a separator it broke the word in two, and a welded affix
  // then pushed the run past the length bound and stranded the wildcard the
  // bare form relies on — so "TheIsafl<Armenian o>w" escaped while
  // "Isafl<Armenian o>w" was refused.
  it('refuses a welded brand that also carries a substituted glyph', () => {
    for (const name of ['TheIsafl\u0585w', 'GoIsafl\u10DDw', 'Isafl\u0585wHQ', 'MyIsafl\u0585wSync']) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(true);
    }
  });

  // Documented residual: the budget is exactly one unidentified character, so
  // two different unmapped look-alikes in one name still register. Recorded as
  // allowed so a budget of two — which would start refusing ordinary words in
  // unmapped scripts — reads as a decision rather than a fix.
  it('allows two substituted glyphs, and says so', () => {
    expect(isReservedClientName(asHandlerWould('\u0585safl\u2C9Fw'))).toBe(false); // Armenian + Coptic
    expect(isReservedClientName(asHandlerWould('\u0585s\u13AAflow'))).toBe(false); // Armenian + Cherokee
  });

  // The brand is coined, so no negation reading applies to it — "UnIsaFlow" is
  // not a disclaimer the way "Unofficial" is, and still trades on the name.
  it('does not let a negation shelter the brand', () => {
    for (const name of ['UnIsaFlow', 'NonIsaFlow', 'NotIsaFlow']) {
      expect(isReservedClientName(asHandlerWould(name)), name).toBe(true);
    }
  });

  // The wildcard budget is one. Without it, a window of N wildcards would match
  // any term of that length, and every word in a script we do not map would be
  // refused.
  it('does not refuse ordinary words in unmapped scripts', () => {
    for (const name of [
      '\u0431\u0443\u0445\u0433\u0430\u043b\u0442\u0435\u0440\u0438\u044f',
      '\u4f1a\u8ba1\u52a9\u624b',
      '\u03bb\u03bf\u03b3\u03b9\u03c3\u03c4\u03b9\u03ba\u03ae',
      // exactly the brand's length, every character unidentified: matches only
      // if the budget is raised, which is what pins it at one.
      '\u4f1a\u8ba1\u52a9\u624b\u7cfb\u7edf\u8868',
    ]) {
      expect(isReservedClientName(asHandlerWould(name)), JSON.stringify(name)).toBe(false);
    }
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
