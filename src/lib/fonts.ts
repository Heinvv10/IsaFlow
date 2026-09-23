import { DM_Sans } from 'next/font/google';

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
export const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans', display: 'swap' });
