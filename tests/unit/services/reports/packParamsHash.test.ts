/**
 * The pack identity: what a pack IS, and the key its commentary is filed under.
 *
 * The boundary test is the point of the file. `report_commentary` is written by
 * the commentary service and read by the shared-pack builder; while this hash
 * lived in the share module, commentary had to import the share module to
 * describe its own primary key. The walker below fails if that import comes
 * back — mutate it by adding any `services/share/...` import to a file under
 * `services/commentary/` and this goes red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalParamsHash } from '@/modules/accounting/services/reports/packParamsHash';

describe('canonicalParamsHash', () => {
  it('is key-order independent', () => {
    const a = canonicalParamsHash({ to: '2026-08-31', from: '2026-03-01', type: 'board' });
    const b = canonicalParamsHash({ type: 'board', from: '2026-03-01', to: '2026-08-31' });
    expect(a).toBe(b);
  });

  it('changes when any field changes', () => {
    const base = canonicalParamsHash({ type: 'board', from: '2026-03-01', to: '2026-08-31' });
    expect(canonicalParamsHash({ type: 'monthly', from: '2026-03-01', to: '2026-08-31' })).not.toBe(base);
    expect(canonicalParamsHash({ type: 'board', from: '2026-03-02', to: '2026-08-31' })).not.toBe(base);
  });
});

const COMMENTARY_DIR = path.resolve(__dirname, '../../../../src/modules/accounting/services/commentary');

/** Every module specifier a file imports from, type-only imports included —
 *  the rule here is about which module OWNS a concept, and a type import
 *  expresses that ownership just as loudly as a value import does. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

describe('the commentary module does not import the share module', () => {
  const files = fs.readdirSync(COMMENTARY_DIR).filter(f => /\.ts$/.test(f));

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} imports nothing from services/share`, () => {
      const specs = importSpecifiers(fs.readFileSync(path.join(COMMENTARY_DIR, file), 'utf8'));
      expect(specs.filter(s => s.includes('services/share'))).toEqual([]);
    });
  }
});
