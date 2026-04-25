#!/usr/bin/env node
import { ESLint } from 'eslint';
import { readFileSync, writeFileSync } from 'node:fs';

const eslint = new ESLint();
const results = await eslint.lintFiles(['src/**/*.tsx', 'pages/**/*.tsx']);

const REPLACE = {
  "'": '&apos;',
  '"': '&quot;',
};

const byFile = new Map();
for (const r of results) {
  const hits = r.messages.filter((m) => m.ruleId === 'react/no-unescaped-entities');
  if (hits.length) byFile.set(r.filePath, hits);
}

for (const [filePath, hits] of byFile) {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  // Sort by line desc, col desc — apply right-to-left so column offsets stay valid.
  hits.sort((a, b) => (b.line - a.line) || (b.column - a.column));
  for (const h of hits) {
    const idx = h.line - 1;
    const line = lines[idx];
    const col = h.column - 1;
    const ch = line[col];
    const repl = REPLACE[ch];
    if (!repl) {
      console.error(`skip ${filePath}:${h.line}:${h.column} — char "${ch}" not in replace map`);
      continue;
    }
    lines[idx] = line.slice(0, col) + repl + line.slice(col + 1);
  }
  writeFileSync(filePath, lines.join('\n'));
  console.log(`fixed ${filePath} (${hits.length} hits)`);
}
