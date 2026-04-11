#!/usr/bin/env node
/**
 * Codemod: wrap every `export default withCompany(withErrorHandler(handler))`
 * in the accounting API with `withWriteAccess(handler)` so viewers can't
 * POST/PUT/PATCH/DELETE.
 *
 * Also adds `withWriteAccess` to the existing `@/lib/auth` import line.
 *
 * Patterns handled:
 *   1. export default withCompany(withErrorHandler(handler));
 *   2. export default withCompany(withErrorHandler(handler as never));
 *
 * Patterns SKIPPED (must be fixed by hand):
 *   - export default withCompany(withErrorHandler(async (req, res) => {...}))  (inline handler)
 *   - export default withCompany(withRole('admin')(withErrorHandler(handler))) (already gated stricter)
 *
 * Usage:
 *   node scripts/codemod-withWriteAccess.mjs          # dry run
 *   node scripts/codemod-withWriteAccess.mjs --write  # apply changes
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const API_DIRS = [
  'pages/api/accounting',
  'pages/api/admin/accounting',
];
const WRITE = process.argv.includes('--write');

const EXPORT_CLEAN = /export default withCompany\(withErrorHandler\(handler\)\);/;
const EXPORT_CAST  = /export default withCompany\(withErrorHandler\(handler as never\)\);/;
const SKIP_INLINE  = /export default withCompany\(withErrorHandler\(async/;
const SKIP_ROLE    = /withCompany\(withRole\(/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile() && extname(full) === '.ts') out.push(full);
  }
  return out;
}

function patchImport(src) {
  // Case 1: existing `import { ... } from '@/lib/auth'`
  const libAuthRe = /import\s*\{([^}]*)\}\s*from\s*'@\/lib\/auth';/;
  const m = libAuthRe.exec(src);
  if (m) {
    const inner = m[1];
    if (inner.includes('withWriteAccess')) return { src, touched: false };
    // Add withWriteAccess to the existing import list, keeping alphabetical-ish order by just appending
    const newInner = inner.trimEnd() + (inner.trimEnd().endsWith(',') ? '' : ',') + ' withWriteAccess';
    return { src: src.replace(libAuthRe, `import {${newInner}} from '@/lib/auth';`), touched: true };
  }
  // Case 2: file imports withCompany from the direct path — add a new import line after the withCompany one
  const directRe = /(import\s*\{[^}]*withCompany[^}]*\}\s*from\s*'@\/lib\/auth\/withCompany';)/;
  if (directRe.test(src)) {
    if (src.includes('withWriteAccess')) return { src, touched: false };
    return {
      src: src.replace(directRe, `$1\nimport { withWriteAccess } from '@/lib/auth/withWriteAccess';`),
      touched: true,
    };
  }
  // Case 3: we can't tell — add a new import at the top of the first import block
  if (src.includes('withWriteAccess')) return { src, touched: false };
  const firstImportRe = /^(import[^;]+;)/m;
  if (firstImportRe.test(src)) {
    return {
      src: src.replace(firstImportRe, `$1\nimport { withWriteAccess } from '@/lib/auth';`),
      touched: true,
    };
  }
  return { src, touched: false };
}

const skipped = [];
const touched = [];
const reasons = new Map();

for (const dir of API_DIRS) {
  try {
    const files = walk(dir);
    for (const file of files) {
      const original = readFileSync(file, 'utf-8');

      if (SKIP_INLINE.test(original)) {
        skipped.push(file);
        reasons.set(file, 'inline async handler');
        continue;
      }
      if (SKIP_ROLE.test(original)) {
        skipped.push(file);
        reasons.set(file, 'already gated via withRole');
        continue;
      }

      let updated = original;
      let exportPatched = false;

      if (EXPORT_CLEAN.test(updated)) {
        updated = updated.replace(
          EXPORT_CLEAN,
          'export default withCompany(withErrorHandler(withWriteAccess(handler)));',
        );
        exportPatched = true;
      } else if (EXPORT_CAST.test(updated)) {
        updated = updated.replace(
          EXPORT_CAST,
          'export default withCompany(withErrorHandler(withWriteAccess(handler) as never));',
        );
        exportPatched = true;
      }

      if (!exportPatched) {
        skipped.push(file);
        reasons.set(file, 'no matching export pattern');
        continue;
      }

      const patched = patchImport(updated);
      updated = patched.src;

      if (WRITE) writeFileSync(file, updated, 'utf-8');
      touched.push(file);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

console.log(`${WRITE ? 'Patched' : 'Would patch'} ${touched.length} files.`);
console.log(`Skipped ${skipped.length} files.`);

if (skipped.length > 0) {
  console.log('\n--- Skipped files by reason ---');
  const byReason = {};
  for (const f of skipped) {
    const r = reasons.get(f);
    (byReason[r] ??= []).push(f);
  }
  for (const [r, files] of Object.entries(byReason)) {
    console.log(`\n[${r}] (${files.length}):`);
    files.forEach(f => console.log(`  ${f}`));
  }
}
