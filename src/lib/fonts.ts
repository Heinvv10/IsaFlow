import localFont from 'next/font/local';

/**
 * The app's typeface, instantiated once.
 *
 * `variable` only exists on elements inside the subtree that carries
 * `dmSans.variable`, and Tailwind's `sans` stack is `var(--font-dm-sans), ...`.
 * An undefined `var()` invalidates the WHOLE font-family declaration — the
 * fallbacks listed after it never apply — so a page outside that subtree does
 * not fall back to system-ui, it falls back to the browser's default serif.
 *
 * It lived in AppLayout, which every signed-out page skips: login, register,
 * reset-password, verify-email and the OAuth consent screen all rendered in
 * Times New Roman. Applied at the _app root instead, so a page gets the font
 * whether or not it uses the app chrome.
 */

/**
 * Self-hosted: the Google-hosted loader fetches the font over the network at BUILD time, and a flaky
 * network failed the CI build and the deploy more than once. The file is the one Google serves for DM Sans (latin
 * subset, variable wght 100-1000, OFL; src/assets/fonts/OFL-DMSans.txt), so rendering is unchanged.
 */
export const dmSans = localFont({
  src: '../assets/fonts/DMSans-latin-variable.woff2',
  weight: '100 1000',
  style: 'normal',
  variable: '--font-dm-sans',
  display: 'swap',
  adjustFontFallback: 'Arial',
});
