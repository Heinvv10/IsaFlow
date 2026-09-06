/**
 * IBCS notation, in one file.
 *
 * The rule this file exists to enforce: a series is styled by its ROLE
 * (actual / prior / budget / forecast), never by its category name, and
 * green and red are issued only by `varianceColor` — so a reader can tell
 * a favourable variance from a category that happens to be called "cash".
 */
import type { ChartPalette } from './chartTypes';

export type SeriesRole = 'actual' | 'prior' | 'budget' | 'forecast';

export interface RoleStyle {
  color: string;
  borderColor?: string;
  borderWidth?: number;
  decal?: {
    symbol: string;
    dashArrayX: number[];
    dashArrayY: number[];
    rotation: number;
    color: string;
  };
}

export function roleStyle(role: SeriesRole, palette: ChartPalette): RoleStyle {
  switch (role) {
    case 'actual':
      return { color: palette.ink, borderWidth: 0 };
    case 'prior':
      return { color: palette.prior, borderWidth: 0 };
    case 'budget':
      // Outline: the plan is a reference the actual is read against, so it
      // must not carry ink weight of its own.
      return { color: 'transparent', borderColor: palette.ink, borderWidth: 1.5 };
    case 'forecast':
      return {
        color: 'transparent',
        borderColor: palette.plan,
        borderWidth: 1,
        decal: {
          symbol: 'rect',
          dashArrayX: [1, 0],
          dashArrayY: [2, 5],
          rotation: -Math.PI / 4,
          color: palette.plan,
        },
      };
  }
}

export function varianceColor(
  favourable: boolean | undefined,
  palette: ChartPalette,
): string | undefined {
  if (favourable === undefined) return undefined;
  return favourable ? palette.fav : palette.unfav;
}

/**
 * A value-axis domain that always contains zero and never truncates. A bar
 * chart whose axis starts at 90% of the smallest bar makes a 2% movement
 * look like a collapse; IBCS forbids it and so does this function.
 */
export function axisDomain(values: number[]): { min: number; max: number } {
  const finite = values.filter(Number.isFinite);
  const lo = Math.min(0, ...finite);
  const hi = Math.max(0, ...finite);
  const span = hi - lo;
  if (span === 0) return { min: lo === 0 ? 0 : lo * 1.08, max: hi === 0 ? 1 : hi * 1.08 };
  const pad = span * 0.08;
  return { min: lo === 0 ? 0 : lo - pad, max: hi === 0 ? 0 : hi + pad };
}
