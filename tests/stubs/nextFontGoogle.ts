/**
 * Stub for `next/font/google`.
 *
 * The real module is a build-time transform: Next rewrites the call during
 * compilation and the runtime export is not a callable function. Vitest does
 * not apply that transform, so any module importing a font throws
 * "DM_Sans is not a function" the moment it is imported — which broke every
 * test that renders pages/_app.tsx once the font moved there.
 *
 * Aliased in both vitest configs, because tests/unit/components/*.test.ts
 * matches the unit config's include as well as the component config's.
 */
type LoadedFont = { variable: string; className: string; style: { fontFamily: string } };

const loadFont = (): LoadedFont => ({
  variable: '__variable_test',
  className: '__className_test',
  style: { fontFamily: 'DM Sans' },
});

export const DM_Sans = loadFont;
export const Inter = loadFont;
