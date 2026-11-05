/**
 * Pentest H7/H8 gate: an address taken from the LEFT of X-Forwarded-For is the client's own to write. The old gate was one
 * grep for `x-forwarded-for']...split`, which missed every spelling that split on another line or used another variable
 * (a copy of exactly this defect sat in the portal invoice service, its PDF and pixel routes, the audit-log export and
 * the analytics fingerprint). This reads each file that mentions the header and flags any leftmost selection of its chain.
 */
import { describe, expect, it } from 'vitest';
import { findLeftmostForwardedFor } from '../../../scripts/ci/clientIpRule';

const hits = (text: string, file = 'src/x.ts') => findLeftmostForwardedFor([{ file, text }]).map((h) => h.line);

describe('leftmost X-Forwarded-For selection is flagged', () => {
  it.each([
    ['split then [0] on the same line', "const ip = (req.headers['x-forwarded-for'] as string).split(',')[0]"],
    ['split then [0]! on a later line', "const xf = req.headers['x-forwarded-for'];\nif (typeof xf === 'string') return xf.split(',')[0]!.trim();"],
    ['split with double quotes and optional chaining', 'const xf = h["x-forwarded-for"];\nreturn xf?.split(",")?.[0]?.trim();'],
    ['split then shift()', "const xf = req.headers['x-forwarded-for'] as string;\nreturn xf.split(',').shift();"],
    ['split then at(0)', "const xf = req.headers['x-forwarded-for'] as string;\nreturn xf.split(',').at(0);"],
    ['an array element zero of the header', "const fwd = req.headers['x-forwarded-for'];\nconst first = Array.isArray(fwd) ? fwd[0] : fwd;"],
    ['a chain variable indexed at zero', "const raw = req.headers['x-forwarded-for'] as string;\nconst ips = raw.split(',').map((s) => s.trim());\nreturn ips[0];"],
    ['a destructured first entry', "const xf = req.headers['x-forwarded-for'] as string;\nconst [first] = xf.split(',');"],
    ['the audit-export shape', "const forwardedFor = req.headers['x-forwarded-for'];\nconst clientIp = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim();"],
  ])('%s', (_label, text) => {
    expect(hits(text).length).toBeGreaterThan(0);
  });
});

describe('what is not leftmost selection is left alone', () => {
  it.each([
    ['the last entry', "const xf = req.headers['x-forwarded-for'] as string;\nconst ips = xf.split(',').map((s) => s.trim());\nreturn ips[ips.length - 1];"],
    ['the shared helper', "import { trustedClientIp } from '@/lib/trustedClientIp';\nconst ip = trustedClientIp(req);"],
    ['a file that never mentions the header, however it splits', "const parts = 'a,b'.split(',')[0];"],
    ['a comment that names the defect', "// the leftmost x-forwarded-for entry: x-forwarded-for.split(',')[0] is client-supplied\nconst ip = 1;"],
    ['a block comment line', "/**\n * x-forwarded-for[0] is forgeable\n */\nexport const a = 1;"],
  ])('%s', (_label, text) => {
    expect(hits(text)).toEqual([]);
  });

  it('the two implementers of the rule are exempt: the trusted helper and getClientIp', () => {
    const text = "const xf = h['x-forwarded-for'] as string; const first = xf.split(',')[0];";
    expect(findLeftmostForwardedFor([{ file: 'src/lib/trustedClientIp.ts', text }, { file: 'src/lib/rateLimit.ts', text }])).toEqual([]);
  });
});
