/**
 * ReDoS-safe regex evaluation — WS-2 (pentest H4).
 *
 * Tenant-authored categorization-rule patterns are compiled with `new RegExp`
 * and run against transaction text on the single-threaded event loop. A
 * catastrophic-backtracking pattern (e.g. `(a+)+$`) would pin the process.
 *
 * Node has no native regex timeout and RE2 is not a dependency, so we defend
 * statically: reject patterns with star-height ≥ 2 (a quantifier applied to a
 * group whose body already contains a quantifier or alternation — the entire
 * catastrophic-backtracking class) plus a length cap, and bound the input.
 * Errs toward rejecting (a flagged pattern is simply not run).
 */

export const MAX_PATTERN_LEN = 200;
export const MAX_INPUT_LEN = 2000;

/** True if `pattern` is prone to catastrophic backtracking (or otherwise unsafe to run). */
export function isReDoSProne(pattern: string): boolean {
  if (!pattern || pattern.length > MAX_PATTERN_LEN) return true;

  type Frame = { hasQuant: boolean; hasAlt: boolean };
  const stack: Frame[] = [];
  let cur: Frame = { hasQuant: false, hasAlt: false };
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') { i++; continue; } // skip the escaped char
    if (inClass) { if (c === ']') inClass = false; continue; }

    switch (c) {
      case '[':
        inClass = true;
        break;
      case '(':
        stack.push(cur);
        cur = { hasQuant: false, hasAlt: false };
        break;
      case ')': {
        const body = cur;
        const parent = stack.pop() ?? { hasQuant: false, hasAlt: false };
        const next = pattern[i + 1];
        const quantified = next === '*' || next === '+' || next === '{' ||
          (next === '?' && (pattern[i + 2] === '*' || pattern[i + 2] === '+'));
        // star-height ≥ 2 (or quantified overlap-prone alternation) → catastrophic class.
        if (quantified && (body.hasQuant || body.hasAlt)) return true;
        // Propagate the body's complexity upward even when this group is NOT directly
        // quantified — otherwise an unquantified wrapper launders an inner quantifier,
        // e.g. ((a+))+$ . A quantified group also counts as a quantifier in the parent.
        parent.hasQuant = parent.hasQuant || body.hasQuant || quantified;
        parent.hasAlt = parent.hasAlt || body.hasAlt;
        cur = parent;
        break;
      }
      case '|':
        cur.hasAlt = true;
        break;
      case '*':
      case '+':
      case '{':
        cur.hasQuant = true;
        break;
      default:
        break;
    }
  }
  return false;
}

/**
 * Compile + test a tenant pattern safely. Returns false (never throws, never
 * hangs) if the pattern is ReDoS-prone, invalid, or simply does not match.
 */
export function safeRegexTest(pattern: string, input: string, flags = 'i'): boolean {
  if (isReDoSProne(pattern)) return false;
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return false;
  }
  const bounded = input.length > MAX_INPUT_LEN ? input.slice(0, MAX_INPUT_LEN) : input;
  return re.test(bounded);
}

/** Validate a pattern at rule-create/update time. */
export function validateRulePattern(pattern: string): { ok: true } | { ok: false; reason: string } {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, reason: 'pattern is empty' };
  }
  if (pattern.length > MAX_PATTERN_LEN) {
    return { ok: false, reason: `pattern exceeds ${MAX_PATTERN_LEN} characters` };
  }
  if (isReDoSProne(pattern)) {
    return { ok: false, reason: 'pattern is too complex (nested quantifiers can cause catastrophic backtracking)' };
  }
  try {
    new RegExp(pattern, 'i');
  } catch {
    return { ok: false, reason: 'pattern is not a valid regular expression' };
  }
  return { ok: true };
}
