/**
 * Stub for `next/font/local` (the self-hosted fonts in src/lib/fonts.ts and DashboardHero).
 *
 * Like `next/font/google`, the real module is a build-time transform: Next rewrites the call during
 * compilation and the runtime default export is not callable, so any module that loads a font throws
 * "default is not a function" under Vitest. See tests/stubs/nextFontGoogle.ts.
 */
type LoadedFont = { variable: string; className: string; style: { fontFamily: string } };

export default function localFont(): LoadedFont {
  return { variable: '__variable_test', className: '__className_test', style: { fontFamily: 'DM Sans' } };
}
