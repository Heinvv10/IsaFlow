/**
 * explained_psp for the EMP501 (wave 6 PSP; coordinator ruling 2026-11-19, review of #1566 L3): which filed EMP201s equal
 * the certificates plus the PSP lines they cover (on no certificate until PSP-H). Split out of emp501Months.ts (300 lines).
 */
import { anyNonZero, differences, monthName, monthsName, versionTotals, type Emp501Filings, type MonthTotals } from './emp501Months';

const add = (a: MonthTotals, b: MonthTotals): MonthTotals => ({
  paye: Math.round((a.paye + b.paye) * 100) / 100, uif: Math.round((a.uif + b.uif) * 100) / 100, sdl: Math.round((a.sdl + b.sdl) * 100) / 100,
});

/** 'PSP PAYE 10800.00 and SDL 400.00', naming only what is not nil. */
function pspFigures(t: MonthTotals): string {
  const parts = [t.paye !== 0 ? `PAYE ${t.paye.toFixed(2)}` : null, t.sdl !== 0 ? `SDL ${t.sdl.toFixed(2)}` : null, t.uif !== 0 ? `UIF ${t.uif.toFixed(2)}` : null];
  return `PSP ${parts.filter(Boolean).join(' and ')}`;
}

/**
 * explained_psp (coordinator ruling 2026-11-19): a filed EMP201 (a lifecycle version, or a legacy row with stored totals)
 * that equals the certificates plus the PSP lines it covers, with any PSP figure (PAYE or SDL) not nil. Never a refusal:
 * 'March 2026: explained by PSP PAYE 4050.00 and SDL 150.00 (PSP-H pending)'.
 */
export function pspExplainedMonths(f: Emp501Filings): string[] {
  const versions = f.months.flatMap((m) => {
    const psp = f.psp.get(m.month);
    if (m.emp201.kind !== 'version' || !anyNonZero(psp)) return [];
    return differences(versionTotals(m.emp201.version), add(m.totals, psp)).length === 0
      ? [`${monthName(m.month)}: explained by ${pspFigures(psp)} (PSP-H pending)`] : [];
  });
  const legacy = f.legacyRows.flatMap((row) => {
    if (!row.stored || !row.spanCertificates || !anyNonZero(row.spanPsp)) return [];
    if (differences(row.stored, add(row.spanCertificates, row.spanPsp)).length > 0) return [];
    const name = monthsName([row.start.slice(0, 7), row.end.slice(0, 7)].filter((m, i, a) => a.indexOf(m) === i));
    return [`${name}${row.reference ? ` (reference ${row.reference})` : ''}: explained by ${pspFigures(row.spanPsp)} (PSP-H pending)`];
  });
  return [...versions, ...legacy];
}
