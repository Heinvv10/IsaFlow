/**
 * THE BREAK-PAIR SCAN: which pairs of characters Chromium breaks between, by the characters either side of them. Run
 * by `scanPairs` in production's Gotenberg image for the committed table (`packBreakPairsImage.test.ts`), or in the
 * print tests' Chromium for a quick look; each step is one page (`PAIR_PROBE`) given a job and printing text lines.
 *  - Classes: every code point of the domain (`breakPairsDomain.ts`) is probed against one of each class, as either
 *    side of a pair, in every context that tells contexts apart, and as the context of every pair whose break depends
 *    on its context; code points that read alike are one class. Repeated until no class splits.
 *  - Tables: for one of each class, does Chromium break between A and B after each context (a letter after the pair),
 *    and before each (a letter before); a break is where both say one.
 *  - Flips: for every pair, in every context before and after, the 4-grams where that rule is wrong. Every pair is
 *    checked: a pair both tables read alike in every context can still break by the two contexts together (in
 *    production's classes, 1,021 of the 2,031 pairs a context changes do).
 * Each probe is a block at width 0 holding the string, so every break opportunity is taken: a pair breaks when its
 * second character sits lower than its first.
 */

/** The contexts beside the classes: the strings set before (`left`) and after (`right`) a probed pair. */
export const SPECIAL_LEFT: readonly string[] = ['', 'a ', 'a\u00AD', 'a\u200B', '\u{1F600}'];
export const SPECIAL_RIGHT: readonly string[] = ['', ' a', '\u00ADa', '\u200Ba', '\u{1F600}'];

/** A page job. `sig`: a hash per code point of `domain`; `tables`: the two tables as hex; `quads`: flips in a range. */
export type PairJob =
  | { kind: 'sig'; domain: number[]; reps: number[]; lefts: string[]; rights: string[]; dependent: Array<[number, number]> }
  | { kind: 'tables'; reps: number[]; lefts: string[]; rights: string[] }
  | { kind: 'quads'; reps: number[]; lefts: string[]; rights: string[]; pairs: Array<[number, number]>; from: number; to: number; left: string; right: string };

export const PAIR_PROBE = `function pairProbe(job) {
  var host = document.getElementById('scan');
  var ch = function (cp) { return String.fromCodePoint(cp); };
  function probe(count, make) {
    var out = new Uint8Array(count);
    for (var i = 0; i < count; i += 20000) {
      var end = Math.min(count, i + 20000);
      var box = document.createElement('div'); box.style.cssText = 'width:0;white-space:normal';
      var ats = [];
      for (var k = i; k < end; k += 1) { var p = make(k); var s = document.createElement('span'); s.style.display = 'block'; s.textContent = p[0]; box.appendChild(s); ats.push(p[1]); }
      host.appendChild(box);
      var spans = box.children;
      for (var j = 0; j < ats.length; j += 1) {
        var node = spans[j].firstChild; var at = ats[j];
        var r1 = document.createRange(); r1.setStart(node, at - 1); r1.setEnd(node, at);
        var r2 = document.createRange(); r2.setStart(node, at); r2.setEnd(node, at + 1);
        var a = r1.getClientRects(); var b = r2.getClientRects();
        out[i + j] = a.length && b.length && b[b.length - 1].top > a[a.length - 1].top + 4 ? 1 : 0;
      }
      host.removeChild(box);
    }
    return out;
  }
  var hex = function (arr) { var s = ''; for (var i = 0; i < arr.length; i += 4) s += ((arr[i] << 3) | ((arr[i + 1] || 0) << 2) | ((arr[i + 2] || 0) << 1) | (arr[i + 3] || 0)).toString(16); return s; };
  var reps = job.reps.map(ch); var K = reps.length; var L = job.lefts; var R = job.rights; var nl = L.length; var nr = R.length;
  var lines = [];
  if (job.kind === 'sig') {
    var dep = job.dependent; var side = 2 * K * (nl + nr); var stride = side + 2 * dep.length;
    var bits = probe(job.domain.length * stride, function (k) {
      var x = ch(job.domain[Math.floor(k / stride)]); var t = k % stride;
      if (t < side) {
        var r = reps[Math.floor(t / (2 * (nl + nr)))]; var u = t % (2 * (nl + nr)); var swap = u % 2 === 1; var c = Math.floor(u / 2);
        var a = swap ? r : x; var b = swap ? x : r;
        return c < nl ? [L[c] + a + b + 'a', L[c].length + 1] : ['a' + a + b + R[c - nl], 2];
      }
      var v = t - side; var pair = dep[Math.floor(v / 2)];
      return v % 2 === 0 ? [x + reps[pair[0]] + reps[pair[1]] + 'a', x.length + 1] : ['a' + reps[pair[0]] + reps[pair[1]] + x, 2];
    });
    job.domain.forEach(function (cp, i) {
      var h = 0x811c9dc5; var g = 0x01000193;
      for (var k = 0; k < stride; k += 1) { h ^= bits[i * stride + k] + 48 + (k & 7); h = Math.imul(h, 0x01000193) >>> 0; g = Math.imul(g ^ (bits[i * stride + k] * (k + 1)), 0x9e3779b1) >>> 0; }
      lines.push('S|' + cp.toString(16) + '|' + h.toString(16) + g.toString(16));
    });
  } else if (job.kind === 'tables') {
    var TL = probe(nl * K * K, function (k) { var l = L[Math.floor(k / (K * K))]; var w = k % (K * K); return [l + reps[Math.floor(w / K)] + reps[w % K] + 'a', l.length + 1]; });
    var TR = probe(K * K * nr, function (k) { var w = Math.floor(k / nr); return ['a' + reps[Math.floor(w / K)] + reps[w % K] + R[k % nr], 2]; });
    for (var i = 0; i < TL.length; i += 320) lines.push('L|' + hex(TL.subarray(i, i + 320)));
    for (var i = 0; i < TR.length; i += 320) lines.push('R|' + hex(TR.subarray(i, i + 320)));
  } else {
    var lb = job.left; var rb = job.right; var bit = function (s, i) { return (parseInt(s[i >> 2], 16) >> (3 - (i & 3))) & 1; };
    // The 4-grams of the pairs listed, by (pair x contexts before + before) x contexts after + after.
    var at = function (k) { var q = job.from + k; var pr = job.pairs[Math.floor(q / (nl * nr))]; return { li: Math.floor(q / nr) % nl, w: pr[0] * K + pr[1], ri: q % nr }; };
    var Q = probe(job.to - job.from, function (k) { var g = at(k); return [L[g.li] + reps[Math.floor(g.w / K)] + reps[g.w % K] + R[g.ri], L[g.li].length + 1]; });
    var flips = [];
    for (var k = 0; k < Q.length; k += 1) {
      var g = at(k);
      var said = bit(lb, g.li * K * K + g.w) && bit(rb, g.w * nr + g.ri) ? 1 : 0;
      if (said !== Q[k]) flips.push(((g.li * K * K + g.w) * nr + g.ri).toString(36));
    }
    for (var i = 0; i < flips.length; i += 16) lines.push('X|' + flips.slice(i, i + 16).join(','));
  }
  lines.push('E|' + job.kind);
  return lines;
}`;

/** Runs one job in a page and returns its lines (Playwright's `page.evaluate`, or a Gotenberg print read back). */
export type PairRunner = (job: PairJob) => Promise<string[]>;

/** One scan read back: each code point's class; the tables as hex; the flips; how many 4-grams were checked. */
export interface PairScan { classOf: Map<number, number>; classes: number; lefts: number; rights: number; left: string; right: string; flips: number[]; quads: number }

const done = (lines: readonly string[], kind: string): string[] => {
  const out = lines.map((l) => l.trim()).filter((l) => l !== '');
  if (!out.includes(`E|${kind}`)) throw new Error(`the pair scan's ${kind} job came back incomplete`);
  return out;
};

const bitOf = (s: string, i: number): number => (parseInt(s[i >> 2]!, 16) >> (3 - (i & 3))) & 1;

/** The tables for the current classes: which contexts read alike, and which pairs a context changes. */
function readTables(lines: string[], k: number, nl: number, nr: number): { left: string; right: string; lefts: number[]; rights: number[]; dependent: Array<[number, number]> } {
  const left = lines.filter((l) => l.startsWith('L|')).map((l) => l.slice(2)).join('');
  const right = lines.filter((l) => l.startsWith('R|')).map((l) => l.slice(2)).join('');
  const distinct = (n: number, f: (c: number, w: number) => number): number[] => {
    const seen = new Map<string, number>();
    for (let c = 0; c < n; c += 1) {
      const key = Array.from({ length: k * k }, (unused, w) => f(c, w)).join('');
      if (!seen.has(key)) seen.set(key, c);
    }
    return [...seen.values()];
  };
  const lefts = distinct(nl, (c, w) => bitOf(left, c * k * k + w));
  const rights = distinct(nr, (c, w) => bitOf(right, w * nr + c));
  const dependent: Array<[number, number]> = [];
  for (let w = 0; w < k * k; w += 1) {
    const l = new Set(Array.from({ length: nl }, (unused, c) => bitOf(left, c * k * k + w)));
    const r = new Set(Array.from({ length: nr }, (unused, c) => bitOf(right, w * nr + c)));
    if (l.size > 1 || r.size > 1) dependent.push([Math.floor(w / k), w % k]);
  }
  return { left, right, lefts, rights, dependent };
}

const contexts = (special: readonly string[], reps: readonly number[]): string[] => [...special, ...reps.map((cp) => String.fromCodePoint(cp))];

/** The whole scan over `domain`, starting from `seed` (one code point of each class a former scan found). */
export async function scanPairs(run: PairRunner, domain: readonly number[], seed: readonly number[], log: (line: string) => void = () => undefined, chunk = 300, rounds = 8): Promise<PairScan> {
  let reps = [...seed].sort((a, b) => a - b);
  let classOf = new Map<number, number>();
  let stable = false;
  for (let round = 0; round < rounds && !stable; round += 1) {
    const lefts = contexts(SPECIAL_LEFT, reps);
    const rights = contexts(SPECIAL_RIGHT, reps);
    const t = readTables(done(await run({ kind: 'tables', reps, lefts, rights }), 'tables'), reps.length, lefts.length, rights.length);
    log(`round ${round}: ${reps.length} classes, ${t.lefts.length} contexts before and ${t.rights.length} after tell pairs apart, ${t.dependent.length} pairs depend on a context`);
    const hashes = new Map<number, string>();
    for (let at = 0; at < domain.length; at += chunk) {
      const job: PairJob = { kind: 'sig', domain: domain.slice(at, at + chunk), reps, lefts: t.lefts.map((c) => lefts[c]!), rights: t.rights.map((c) => rights[c]!), dependent: t.dependent };
      for (const l of done(await run(job), 'sig').filter((x) => x.startsWith('S|'))) { const [, cp, h] = l.split('|'); hashes.set(parseInt(cp!, 16), h!); }
    }
    if (hashes.size !== domain.length) throw new Error(`the pair scan signed ${hashes.size} of ${domain.length} code points`);
    const keys = new Map<string, number>();
    const next: number[] = [];
    classOf = new Map();
    for (const cp of domain) {
      const h = hashes.get(cp)!;
      if (!keys.has(h)) { keys.set(h, keys.size); next.push(cp); }
      classOf.set(cp, keys.get(h)!);
    }
    stable = next.length === reps.length && next.every((cp, i) => cp === reps[i]);
    reps = next;
    if (reps.length > 160) throw new Error(`the pair scan split the domain into ${reps.length} classes: too many to table`);
  }
  // A table written from classes still splitting would read some code points as a class they do not break as.
  if (!stable) throw new Error(`the pair scan's classes did not settle in ${rounds} rounds (${reps.length} classes at the last)`);
  const lefts = contexts(SPECIAL_LEFT, reps);
  const rights = contexts(SPECIAL_RIGHT, reps);
  const k = reps.length;
  const t = readTables(done(await run({ kind: 'tables', reps, lefts, rights }), 'tables'), k, lefts.length, rights.length);
  // Every 4-gram: a pair can break by both contexts together where neither table alone shows a context changing it.
  const pairs = Array.from({ length: k * k }, (unused, w): [number, number] => [Math.floor(w / k), w % k]);
  const quads = pairs.length * lefts.length * rights.length;
  const flips: number[] = [];
  log(`${k} classes: checking ${quads} 4-grams`);
  for (let from = 0; from < quads; from += 600_000) {
    const lines = done(await run({ kind: 'quads', reps, lefts, rights, pairs, from, to: Math.min(quads, from + 600_000), left: t.left, right: t.right }), 'quads');
    for (const l of lines.filter((x) => x.startsWith('X|'))) flips.push(...l.slice(2).split(',').map((f) => parseInt(f, 36)));
  }
  return { classOf, classes: k, lefts: lefts.length, rights: rights.length, left: t.left, right: t.right, flips: flips.sort((a, b) => a - b), quads };
}

/** The page that runs `job` in Gotenberg (the pack's print stylesheet, its faces), printing its lines. */
export function pairJobDocument(css: string, job: PairJob): string {
  const run = `(async function () {
  await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
  await document.fonts.ready;
  ${PAIR_PROBE}
  var lines = pairProbe(${JSON.stringify(job)});
  document.documentElement.className = ''; document.head.innerHTML = ''; document.body.innerHTML = '';
  var pre = document.createElement('pre'); pre.style.cssText = 'font:7px monospace;white-space:pre;margin:0';
  pre.textContent = lines.join('\\n'); document.body.appendChild(pre);
  window.parityDone = true;
})();`;
  return '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
    + `<style>${css}</style></head><body><div class="pack-pages"><div class="pack-page"><div id="scan"></div></div></div><script>${run}</script></body></html>`;
}
