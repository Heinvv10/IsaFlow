/**
 * Global module shims for asset-style side-effect imports.
 *
 * TypeScript 6.0 tightened the default loader for side-effect imports
 * (e.g. `import '../styles/globals.css'`) and now requires an explicit
 * declaration. Next.js handles the actual asset at build time; this
 * file just teaches the type-checker that those modules exist.
 */

declare module '*.css';
declare module '*.module.css';
declare module '*.scss';
declare module '*.module.scss';
