/**
 * Pentest H7/H8: an address taken from the LEFT of X-Forwarded-For is the client's own to write. Detection logic for
 * scripts/ci/check-client-ip.ts (unit-tested in tests/unit/ci/clientIpRule.test.ts).
 *
 * The old gate was one grep for `x-forwarded-for ... .split` on the same line; every copy that read the header into a
 * variable first, indexed an array, shifted, or destructured got past it. This reads each file that mentions the header
 * and flags any leftmost selection of a chain in it: `.split(...)[0]` / `.shift()` / `.at(0)` / `[first] = ...split`,
 * and element zero of the usual chain variables. Code that names the defect in a comment is skipped, and so are the two
 * files that implement the rule (the trusted helper, which walks the chain from the right, and getClientIp).
 *
 * Limit (stated): a chain indexed under an unusual variable name and never split in the same file is not seen; the
 * answer to that is that every reader of the header goes through `trustedClientIp`.
 */

export interface SourceFile { file: string; text: string }
export interface Hit { file: string; line: number; text: string }

const EXEMPT = new Set(['src/lib/trustedClientIp.ts', 'src/lib/rateLimit.ts']);

const LEFTMOST: RegExp[] = [
  /\.split\(\s*(['"`]),\1\s*\)\s*\)?\s*(?:\?\.|!)?\s*\[\s*0\s*\]/,       // .split(',')[0]   .split(",")?.[0]
  /\.split\(\s*(['"`]),\1\s*\)\s*\)?\s*(?:\?\.|\.)\s*(?:shift|at)\(\s*0?\s*\)/, // .split(',').shift()   .at(0)
  /\[\s*\w+\s*\]\s*=\s*[\w.$?!()\s]*\.split\(\s*(['"`]),\1\s*\)/,         // const [first] = x.split(',')
  /\b(?:xf|fwd|forwarded|forwardedFor|forwardedIps?|ips?|chain|hops|addresses|parts)\s*(?:\?\.)?\[\s*0\s*\]/i, // ips[0], fwd[0]
];

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

export function findLeftmostForwardedFor(files: SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const { file, text } of files) {
    if (EXEMPT.has(file) || !/x-forwarded-for/i.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      if (isComment(line)) return;
      if (LEFTMOST.some((re) => re.test(line))) hits.push({ file, line: i + 1, text: line.trim() });
    });
  }
  return hits;
}
