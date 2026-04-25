#!/usr/bin/env node
import { ESLint } from 'eslint';
import { readFileSync, writeFileSync } from 'node:fs';

const eslint = new ESLint();
const results = await eslint.lintFiles(['src/**/*.{ts,tsx}', 'pages/**/*.{ts,tsx}']);

const byFile = new Map();
for (const r of results) {
  const hits = r.messages.filter(
    (m) => m.severity === 2 && m.ruleId === null && /Unused eslint-disable directive/.test(m.message),
  );
  if (hits.length) byFile.set(r.filePath, hits);
}

const DIRECTIVE_RE = /\s*\/\*\s*eslint-disable[^*]*\*\/|\s*\/\/\s*eslint-disable(?:-next-line|-line)?[^\n]*/g;

for (const [filePath, hits] of byFile) {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  // hits sorted by line desc
  hits.sort((a, b) => b.line - a.line);
  for (const h of hits) {
    const idx = h.line - 1;
    let line = lines[idx];
    // Remove the disable directive on this line (block or line comment).
    const without = line.replace(DIRECTIVE_RE, '');
    if (without.trim().length === 0) {
      // Whole line was just the directive — drop it
      lines.splice(idx, 1);
    } else {
      lines[idx] = without;
    }
  }
  writeFileSync(filePath, lines.join('\n'));
  console.log(`fixed ${filePath} (${hits.length} hits)`);
}
