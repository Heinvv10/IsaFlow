/**
 * The trip-wire's rule, exercised without walking the tree.
 *
 * The case that matters most is the comment one: a file that TALKS about the
 * guard must not be read as using it. `bankAllocationService` documents the
 * funnel at length precisely to explain why it does not call it.
 */

import { describe, it, expect } from 'vitest';
import { inspectVatGuardCoverage, stripComments } from '../../../scripts/ci/vatGuardRules';

describe('inspectVatGuardCoverage — what is in scope', () => {
  it('ignores a file that does no VAT work', () => {
    expect(inspectVatGuardCoverage('export const x = 1;')).toBeNull();
  });

  it('catches VAT arithmetic of its own', () => {
    const r = inspectVatGuardCoverage('const net = total / (100 + SA_VAT_RATE_PCT);');
    expect(r?.kinds).toContain('rate_constant');
  });

  it('catches a claiming code written onto a journal line', () => {
    expect(inspectVatGuardCoverage("lines.push({ vatType: 'standard' })")?.kinds)
      .toContain('claiming_literal');
    expect(inspectVatGuardCoverage("{ vat_type: 'zero_rated' }")?.kinds)
      .toContain('claiming_literal');
  });

  it('catches handing a code to the poster that enforces nothing', () => {
    expect(inspectVatGuardCoverage('await allocateTransaction(companyId, id)')?.kinds)
      .toContain('allocate_call');
  });

  it('does not flag a non-claiming code', () => {
    expect(inspectVatGuardCoverage("const a = { vatType: 'exempt' };")).toBeNull();
    expect(inspectVatGuardCoverage("const a = { vatType: undefined };")).toBeNull();
  });
});

describe('inspectVatGuardCoverage — what counts as guarded', () => {
  const decides = 'const net = total / (100 + VAT_RATE);';

  it('accepts an import of the resolution funnel', () => {
    const src = `import { resolveRuleVatCode } from '../gl/ruleVatResolution';\n${decides}`;
    expect(inspectVatGuardCoverage(src)?.guarded).toBe(true);
  });

  it('accepts the denial funnel and the MCP guard too', () => {
    for (const mod of ['./inputVatDenial', './allocationVatGuard']) {
      const src = `import { x } from '${mod}';\n${decides}`;
      expect(inspectVatGuardCoverage(src)?.guarded, mod).toBe(true);
    }
  });

  it('REFUSES a file that only mentions the guard in a comment', () => {
    const src = `// The unattended callers route through gl/ruleVatResolution.\n${decides}`;
    expect(inspectVatGuardCoverage(src)?.guarded).toBe(false);
  });

  it('REFUSES a guard named only inside a string', () => {
    const src = `const doc = 'see inputVatDenial';\n${decides}`;
    expect(inspectVatGuardCoverage(src)?.guarded).toBe(false);
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
