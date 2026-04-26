#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import path from 'node:path';

const routeExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const specialRootPages = new Set(['_app', '_document', '_error']);

const pagesDir = path.resolve(process.argv[2] ?? 'pages');

async function collectRouteFiles(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await collectRouteFiles(fullPath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name);
    if (routeExtensions.has(extension)) {
      files.push(fullPath);
    }
  }

  return files;
}

function routePathFor(filePath) {
  const relativePath = path.relative(pagesDir, filePath);
  const parsed = path.parse(relativePath);
  const extension = parsed.ext;
  const withoutExtension = relativePath.slice(0, -extension.length);
  const segments = withoutExtension.split(path.sep);

  if (segments.length === 1 && specialRootPages.has(segments[0])) {
    return null;
  }

  if (segments.at(-1) === 'index') {
    segments.pop();
  }

  return `/${segments.join('/')}`.replace(/\\/g, '/').replace(/\/$/, '') || '/';
}

function relativeForOutput(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, '/');
}

let routeFiles;
try {
  routeFiles = await collectRouteFiles(pagesDir);
} catch (error) {
  console.error(`Could not scan Next.js pages directory: ${pagesDir}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const routeMap = new Map();

for (const filePath of routeFiles) {
  const routePath = routePathFor(filePath);
  if (!routePath) {
    continue;
  }

  const existing = routeMap.get(routePath) ?? [];
  existing.push(filePath);
  routeMap.set(routePath, existing);
}

const collisions = [...routeMap.entries()].filter(([, files]) => files.length > 1);

if (collisions.length > 0) {
  console.error('Duplicate Next.js pages routes detected.');
  console.error('Each route path must map to exactly one file; index routes collide with sibling files.');

  for (const [routePath, files] of collisions) {
    console.error('');
    console.error(`${routePath}:`);
    for (const filePath of files.sort()) {
      console.error(`  - ${relativeForOutput(filePath)}`);
    }
  }

  process.exit(1);
}

console.log(`No duplicate Next.js pages routes found in ${relativeForOutput(pagesDir)}.`);
