/**
 * TENANT PROSE THAT BREAKS INSIDE A TOKEN: pasted links and hyphenated file names (#1263 round 1, the adversary's H1).
 * The adversary's generators, ported as they ran (`/home/hein/audit-archive/p3fu/reviews-1263/adv-work/gen{1,4,5,6,7}.mjs`,
 * the same seeds and the same arithmetic, so the same strings): a journal description carrying one, the matters'
 * issue as `packMatterSources` words it, commentary with links, and the UAX 14 probes that did not break.
 */
const seeded = (start: number): (() => number) => {
  let seed = start;
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
};
const picker = (r: () => number) => <T>(from: readonly T[]): T => from[Math.floor(r() * from.length)]!;

const SEGMENTS = 'payroll adjustment march april 2026 approved by cfo final v2 v3 accrual reversal supplier invoice scan bank recon fnb absa standard capitec vat201 period close journal upload batch import sage xero migration opening balances'.split(' ');
const SHAREPOINT_SEGMENTS = 'payroll adjustment march april 2026 approved by cfo final v2 accrual reversal supplier invoice scan bank recon vat201 period close journal upload batch import migration opening balances board pack'.split(' ');

/** 24 long chains (gen5, "mat1"): a description that is mostly one hyphenated token. */
export function chainDescriptions(): string[] {
  const r = seeded(9);
  const pick = picker(r);
  return Array.from({ length: 24 }, () => {
    const k = 8 + Math.floor(r() * 30);
    const parts = Array.from({ length: k }, () => pick(SEGMENTS));
    return pick(['Reclass per ', 'Accrual reversal, see ', 'Posted from ']) + (r() < 0.5 ? 'https://drive.example.co.za/shared/' : '') + parts.join('-') + (r() < 0.5 ? '.xlsx' : '');
  });
}

/** 30 realistic link and file-name descriptions (gen6, "mat2"); cases 13 and 22 printed page 11 a sheet long. */
export function linkDescriptions(): string[] {
  const r = seeded(21);
  const pick = picker(r);
  return Array.from({ length: 30 }, () => {
    const k = 5 + Math.floor(r() * 12);
    const name = Array.from({ length: k }, () => pick(SHAREPOINT_SEGMENTS)).join('-');
    const t = r();
    const token = t < 0.4 ? `https://velocityfibre.sharepoint.com/sites/Finance/Shared-Documents/2026/${name}.xlsx`
      : t < 0.7 ? `https://drive.google.com/file/d/1A2b3C4d5E6f7G8h9I0j/view?usp=sharing-${name}` : `${name}.pdf`;
    return pick(['Reclass per ', 'Accrual reversal, see ', 'Correction per CFO, file ', 'Posted from ']) + token + pick(['', ' for March.', ' approved by the CFO.']);
  });
}

/** 240 matters issues as `packMatterSources` words a journal's (gen4, "prose4"). */
export function issueTexts(): string[] {
  const r = seeded(3);
  const pick = picker(r);
  const pre = ['Journal JE-2026-00417 (large round-number amount): ', 'Journal JE-2026-00061 (recorded well after its entry date): '];
  const body = ['Reclass per ', 'Correction as per ', 'Accrual reversal, see ', 'Posted from ', 'Per CFO email, file ', ''];
  return Array.from({ length: 240 }, () => {
    const k = 4 + Math.floor(r() * 9);
    const parts = Array.from({ length: k }, () => pick(SEGMENTS));
    let token = parts.join(pick(['-', '-', '_', '-']));
    const kind = r();
    if (kind < 0.35) token += pick(['.xlsx', '.pdf', '.csv']);
    else if (kind < 0.7) token = `https://drive.example.co.za/shared/${parts.join('-')}`;
    return pick(pre) + pick(body) + token + (r() < 0.5 ? '' : ` ${pick(['for March.', 'approved.', 'pending review.'])}`);
  });
}

/** 120 commentaries of 300 to 1,450 characters with links and file names in them (gen7, "prose7"). */
export function commentaryWithLinks(): string[] {
  const r = seeded(33);
  const pick = picker(r);
  const words = 'Revenue grew on the Gauteng rollout and costs were held flat while the depot in Pretoria opened. The board should note the'.split(' ');
  return Array.from({ length: 120 }, () => {
    let s = '';
    const len = 300 + Math.floor(r() * 1150);
    while (s.length < len) {
      if (r() < 0.12) {
        const k = 6 + Math.floor(r() * 25);
        const name = Array.from({ length: k }, () => pick(SHAREPOINT_SEGMENTS)).join('-');
        s += pick(['https://velocityfibre.sharepoint.com/sites/Finance/Shared-Documents/2026/', 'see ', '']) + name + pick(['.xlsx ', ' ', '. ']);
      } else s += `${pick(words)} `;
    }
    return s.trim();
  });
}

/** 200 UAX 14 probes (gen1): punctuation after a space, slash lists, short chains, soft hyphens, money. */
export function punctuationTexts(): string[] {
  const r = seeded(7);
  const pick = picker(r);
  const words = 'revenue costs salaries wages rent rates repairs maintenance motor vehicle fuel insurance bank charges depreciation interest Pretoria Gauteng rollout depot fibre installations customers subscriptions variance budget forecast quarter margin overheads accruals provision'.split(' ');
  const out: string[] = [];
  for (const j of [' / ', ' ; ', ' : ', ' ! ', ' ? ', ' ) ', ' ( ', ', ', ' - ', ' \u2013 ', ' \u2026 ', ' %', ' \u201D']) {
    for (let n = 0; n < 12; n += 1) {
      let s = '';
      const len = 20 + Math.floor(r() * 220);
      while (s.length < len) s += pick(words) + (r() < 0.5 ? j : ' ');
      out.push(s.trim());
    }
  }
  for (let n = 0; n < 30; n += 1) {
    let s = 'Costs above budget in ';
    const k = 3 + Math.floor(r() * 25);
    for (let i = 0; i < k; i += 1) s += `${pick(words)} / ${pick(words)}${i < k - 1 ? ', ' : '.'}`;
    out.push(s);
  }
  for (let n = 0; n < 30; n += 1) {
    const seg: string[] = [];
    const k = 3 + Math.floor(r() * 14);
    for (let i = 0; i < k; i += 1) seg.push(pick(words));
    out.push(`${r() < 0.5 ? `See https://www.example.co.za/${seg.join('-')}` : `File ${seg.join('-')}.pdf`} for the ${pick(words)} detail.`);
  }
  for (let n = 0; n < 20; n += 1) {
    let s = '';
    while (s.length < 60 + r() * 200) s += `${pick(words).replace(/(...)/, '$1\u00AD')} `;
    out.push(s.trim());
  }
  for (let n = 0; n < 20; n += 1) {
    let s = '';
    while (s.length < 60 + r() * 200) s += `R${Math.floor(r() * 1e6).toLocaleString('en-ZA')} ${pick(words)} ${Math.floor(r() * 100)}.${Math.floor(r() * 10)}% `;
    out.push(s.trim());
  }
  return out;
}

/** Everyday compounds in the matters' narrow prose columns (owner, decision): 2 lines in the old model, 3 printed. */
export const NARROW_COMPOUNDS = ['cost-to-company confirm', 'Mid-Vaal-Fibre-Rollout cost-to-company'];
