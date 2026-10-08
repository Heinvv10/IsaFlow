/**
 * Bundle the print pages for a real browser with the same bundler the unit
 * tests run on (Vite), so a Chromium test can load the actual components.
 */
import path from 'node:path';
import { build } from 'vite';

const ROOT = path.resolve(__dirname, '../../../..');

export async function bundlePrintPages(entry = path.join(__dirname, 'printPageEntry.tsx')): Promise<string> {
  const result = await build({
    root: ROOT,
    configFile: false,
    logLevel: 'error',
    mode: 'production',
    // The automatic runtime in its PRODUCTION form: vitest sets NODE_ENV=test, which would make the
    // React plugin emit `jsxDEV`, and the production React this bundles has none.
    oxc: { jsx: { runtime: 'automatic', development: false } },
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    resolve: {
      alias: [
        { find: 'next/dynamic', replacement: path.join(__dirname, 'nextDynamicShim.tsx') },
        { find: /^(node:)?async_hooks$/, replacement: path.join(__dirname, 'asyncHooksShim.ts') },
        { find: '@', replacement: path.join(ROOT, 'src') },
      ],
    },
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ['iife'], name: 'PrintPages', fileName: 'print-pages' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []));
  const chunk = outputs.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('bundlePrintPages: the bundle produced no chunk');
  return chunk.code;
}
