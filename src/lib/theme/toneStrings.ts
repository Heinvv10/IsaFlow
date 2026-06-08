/**
 * Tone-of-voice copy keyed by semantic action and theme mode.
 * Practitioner = terse/operational. Client = warm/plain-language.
 */
import type { ThemeMode } from './themeMode';

export type ToneKey = 'reconcileCta';

interface ToneVars {
  count: number;
}

type ToneFn = (mode: ThemeMode, vars: ToneVars) => string;

const TONE: Record<ToneKey, ToneFn> = {
  reconcileCta: (mode, { count }) =>
    mode === 'client'
      ? `${count} thing${count === 1 ? '' : 's'} to tidy up`
      : `Reconcile ${count}`,
};

export function toneString(key: ToneKey, mode: ThemeMode, vars: ToneVars): string {
  const fn = TONE[key];
  if (!fn) return String(key);
  return fn(mode, vars);
}
