/**
 * ReDoS guard tests — WS-2 (pentest H4). Tenant-authored categorization rule
 * patterns must never be able to hang the event loop via catastrophic backtracking.
 */
import { describe, it, expect } from 'vitest';
import { isReDoSProne, safeRegexTest, validateRulePattern } from '@/lib/safeRegex';

describe('isReDoSProne — flags catastrophic-backtracking patterns', () => {
  it('flags nested quantifiers', () => {
    for (const p of ['(a+)+', '(a+)+$', '(a*)*', '(.*)*', '(\\d+)+', '((ab)+)*', '(a+)*', '([a-z]+)+']) {
      expect(isReDoSProne(p), p).toBe(true);
    }
  });

  it('flags laundered nested quantifiers behind unquantified wrapper groups (review bypass)', () => {
    // ((a+))+$ etc. — an unquantified wrapper must NOT hide the inner quantifier.
    for (const p of ['((a+))+$', '((a*))*$', '(((a+)))+$', '(x(a+))+$', '((a+)x)+$', '((ab+))+$', 'INV((a+))+$']) {
      expect(isReDoSProne(p), p).toBe(true);
      expect(validateRulePattern(p).ok, `validate ${p}`).toBe(false);
    }
  });

  it('flags quantified alternation groups (overlap-prone)', () => {
    for (const p of ['(a|a)+', '(a|ab)*', '(.|\\n)*x(.|\\n)*y(.|\\n)*z(.|\\n)*']) {
      expect(isReDoSProne(p), p).toBe(true);
    }
  });

  it('flags over-long patterns', () => {
    expect(isReDoSProne('a'.repeat(201))).toBe(true);
  });

  it('allows ordinary safe patterns', () => {
    for (const p of ['^INV-\\d+$', 'payment.*received', '[a-z0-9._%+-]+@[a-z]+\\.com', '(abc)+', 'foo|bar', 'EFT|POS|ATM', '\\bsalary\\b']) {
      expect(isReDoSProne(p), p).toBe(false);
    }
  });
});

describe('safeRegexTest — bounded, refuses dangerous patterns', () => {
  it('matches safe patterns normally', () => {
    expect(safeRegexTest('^inv-\\d+$', 'INV-1024')).toBe(true);
    expect(safeRegexTest('salary', 'monthly salary run')).toBe(true);
    expect(safeRegexTest('^x$', 'y')).toBe(false);
  });

  it('refuses (returns false) a catastrophic pattern WITHOUT hanging', () => {
    const malicious = '(a+)+$';
    const evil = 'a'.repeat(40) + '!'; // would hang a naive RegExp.test
    const start = Date.now();
    expect(safeRegexTest(malicious, evil)).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('returns false for invalid regex', () => {
    expect(safeRegexTest('(', 'x')).toBe(false);
  });

  it('bounds very long input (no hang on a safe but greedy pattern)', () => {
    const start = Date.now();
    // match 'az' falls within the input cap; trailing 100k chars are truncated
    expect(safeRegexTest('a.*z', 'az' + 'b'.repeat(100000))).toBe(true);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('validateRulePattern — rule-create gate', () => {
  it('accepts a safe pattern', () => {
    expect(validateRulePattern('^INV-\\d+$')).toEqual({ ok: true });
  });
  it('rejects a dangerous pattern with a reason', () => {
    const r = validateRulePattern('(a+)+');
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it('rejects an invalid regex', () => {
    expect(validateRulePattern('(').ok).toBe(false);
  });
});
