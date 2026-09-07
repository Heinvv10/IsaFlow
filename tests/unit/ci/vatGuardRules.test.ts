/**
 * The trip-wire's rule, exercised without walking the tree.
 *
 * Every case below that starts "REFUSES" or "catches" is a hole the first cut
 * actually had. A blind reviewer wrote three bypasses in ordinary,
 * non-adversarial code and all three sailed through; they are the tests now.
 */

import { describe, it, expect } from 'vitest';
import {
  callsAPostingFunction, importsAndUsesGuard, inspectVatGuardCoverage, stripComments,
} from '../../../scripts/ci/vatGuardRules';

const POSTS = 'await createJournalEntry(companyId, entry, userId);';

describe('inspectVatGuardCoverage — what is in scope', () => {
  it('ignores a file that does no VAT work', () => {
    expect(inspectVatGuardCoverage('export const x = 1;')).toBeNull();
  });

  it('catches named VAT machinery, whatever the constant is called', () => {
    for (const name of ['SA_VAT_RATE_PCT', 'VAT_RATE', 'DEFAULT_VAT_RATE', 'VAT_PCT']) {
      expect(inspectVatGuardCoverage(`const n = t / (100 + ${name});`)?.kinds, name)
        .toContain('rate_constant');
    }
  });

  it('catches a vat type ASSIGNED, not just written as an object literal', () => {
    // `line.vatType = code` is how anyone building a line incrementally writes
    // it, and the first cut only matched the object-literal colon form.
    const src = `line.vatType = decide();\n${POSTS}`;
    expect(inspectVatGuardCoverage(src)?.kinds).toContain('vat_field_on_a_posting_path');
  });

  it('catches it with double quotes and with a variable on the right', () => {
    expect(inspectVatGuardCoverage(`const l = { vatType: "standard" };\n${POSTS}`)?.kinds)
      .toContain('vat_field_on_a_posting_path');
    expect(inspectVatGuardCoverage(`const l = { vat_type: code };\n${POSTS}`)?.kinds)
      .toContain('vat_field_on_a_posting_path');
  });

  it('counts a raw INSERT as posting, not only the service functions', () => {
    const src = 'line.vatType = c;\nawait sql`INSERT INTO gl_journal_lines (vat_type) VALUES (${c})`;';
    expect(inspectVatGuardCoverage(src)?.kinds).toContain('vat_field_on_a_posting_path');
  });

  it('catches a posting function called under an import ALIAS', () => {
    // `import { createJournalEntry as post }` and a `post(` call site left the
    // file not merely unguarded but INVISIBLE — no finding, no allowlist
    // entry, silently skipped. The guard side already followed aliases; the
    // posting side did not.
    const src = "import { createJournalEntry as post } from '../gl/journalEntryService';\n"
      + 'const l = { vatType: r.vat };\nawait post(companyId, { lines: [l] }, userId);';
    expect(inspectVatGuardCoverage(src)?.kinds).toContain('vat_field_on_a_posting_path');
  });

  it('does not treat an unrelated function called `post` as a posting call', () => {
    const src = 'const l = { vatType: c };\nawait post(body);';
    expect(callsAPostingFunction(src)).toBe(false);
  });

  it('catches handing a code to the poster that enforces nothing', () => {
    expect(inspectVatGuardCoverage('await allocateTransaction(companyId, id)')?.kinds)
      .toContain('allocate_call');
  });

  it('leaves a vat type alone when the file posts nothing', () => {
    // Reports read vat_type constantly. The field is only a decision when
    // something puts it in the ledger.
    expect(inspectVatGuardCoverage("const l = { vatType: 'standard' };")).toBeNull();
  });
});

describe('inspectVatGuardCoverage — what counts as guarded', () => {
  const decides = 'const net = total / (100 + VAT_RATE);';

  it('accepts an import that is actually used', () => {
    const src = `import { resolveRuleVatCode } from '../gl/ruleVatResolution';\n`
      + `${decides}\nawait resolveRuleVatCode(input);`;
    expect(inspectVatGuardCoverage(src)?.guarded).toBe(true);
  });

  it('accepts the denial funnel and the MCP guard too', () => {
    for (const mod of ['./inputVatDenial', './allocationVatGuard']) {
      const src = `import { applyGuard } from '${mod}';\n${decides}\napplyGuard(x);`;
      expect(inspectVatGuardCoverage(src)?.guarded, mod).toBe(true);
    }
  });

  it('REFUSES an import that is never used', () => {
    // "Imports, not mentions" was enforced; "imports, not IGNORES" was not.
    const src = `import { resolveRuleVatCode } from '../gl/ruleVatResolution';\n${decides}`;
    expect(inspectVatGuardCoverage(src)?.guarded).toBe(false);
  });

  it('REFUSES an import-shaped line inside a BLOCK comment', () => {
    // The first cut anchored on `^\s*import` against raw source, which rules
    // out a `//` prefix but not a `/* */` wrapper.
    const src = `/*\nimport { resolveRuleVatCode } from '../gl/ruleVatResolution';\n*/\n${decides}`;
    expect(inspectVatGuardCoverage(src)?.guarded).toBe(false);
  });

  it('REFUSES a file that only mentions the guard in a line comment', () => {
    const src = `// The unattended callers route through gl/ruleVatResolution.\n${decides}`;
    expect(inspectVatGuardCoverage(src)?.guarded).toBe(false);
  });

  it('REFUSES a guard named only inside a string', () => {
    expect(inspectVatGuardCoverage(`const d = 'see inputVatDenial';\n${decides}`)?.guarded)
      .toBe(false);
  });

  it('follows a renamed binding', () => {
    const src = `import { resolveRuleVatCode as resolve } from './ruleVatResolution';\n`
      + `${decides}\nresolve(x);`;
    expect(importsAndUsesGuard(src)).toBe(true);
  });
});

describe('stripComments', () => {
  it('does not let a commented-out decision put a file in scope', () => {
    expect(inspectVatGuardCoverage('// const net = x / (100 + VAT_RATE);')).toBeNull();
    expect(inspectVatGuardCoverage("/* vatType: 'standard' */")).toBeNull();
  });

  it('leaves a URL in a string alone', () => {
    expect(stripComments("const u = 'https://x.co/a';")).toContain('https://x.co/a');
  });
});
