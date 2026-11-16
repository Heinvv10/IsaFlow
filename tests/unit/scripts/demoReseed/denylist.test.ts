import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { QA_ARTEFACT_DENYLIST, REAL_NAME_DENYLIST, findDeniedNames } from '../../../../scripts/lib/demoReseed/denylist';
import { EMPLOYEES } from '../../../../scripts/lib/demoReseed/employees';
import { ASSETS, CUSTOMERS, ITEMS, PRACTICE_CLIENTS, SALES_LINES, SUPPLIERS } from '../../../../scripts/lib/demoReseed/fixtures';
import { generateDemoData } from '../../../../scripts/lib/demoReseed/generate';
import { SEED_TABLES } from '../../../../scripts/lib/demoReseed/types';
import { inputFor } from './input';

/** Every real or QA name the brief and the 16 Nov prod dump found in the Demo company, and the old seeders' names. */
const MUST_FLAG = [
  'DFA (Dark Fibre Africa)', 'Dark Fibre Africa', 'Frogfoot Networks', 'Herotel (Pty) Ltd', 'LinkAfrica Telecoms',
  'Metrofibre Networx', 'Openserve (SOC)', 'VelocityFibre (Pty) Ltd', 'Vumatel Holdings', 'Bidvest Cleaning',
  'Eskom Holdings SOC Ltd', 'Eskom Holdings SOC Ltd [MERGED]', '[MERGED] Eskom Holdings', 'Eskom Holdings SOC Ltd (QA FRAUD) [MERGED]',
  'Builders Warehouse', 'City of Johannesburg', 'City of JHB', 'Engen Petroleum', 'Makro SA (Pty) Ltd', 'Sage SA (Pty) Ltd',
  'Telkom SA SOC Ltd', 'Telkom SA SOC Ltd [MERGED]', 'Vodacom Business', 'Office National', 'Karabina Technologies',
  'Cape Office Supplies CC', 'Cape Office Supplies CC [MERGED]', 'FNB', 'FNB Business Banking',
  'Koenig Solutions', 'UNISA', 'USB Executive Development', 'Edge Learning Media',
  '0GP-Golden-Customer', '0GP-Golden-Supplier', '0GP-Golden-Asset', 'QA demo claim', 'Phase 10 e2e retest',
  'DEMO UX Practice Client', 'QA Demo Mailbox', 'AUDIT-0704 Customer', 'AUDIT-0704 Supplier', 'StressTest Co 12',
  'StressTest Customer 3', 'QA Test Customer Pty Ltd', 'QA Test Supplier 2', 'P5 Acceptance Supplier', 'E2E Test Customer 1712',
  'Loop Test 44',
];

/** Built from parts so this file does not match itself. */
const WRONG_BRAND = new RegExp(['IS', 'AFlow|Isa', 'flow'].join(''));

describe('denylist', () => {
  it.each(MUST_FLAG)('flags %s', (name) => {
    expect(findDeniedNames(name).length).toBeGreaterThan(0);
  });

  it('catches every listed term inside a sentence', () => {
    for (const t of [...REAL_NAME_DENYLIST, ...QA_ARTEFACT_DENYLIST]) expect(findDeniedNames(`Paid to ${t} for services.`), t).not.toEqual([]);
  });

  it('matches the short terms as whole words only', () => {
    for (const ok of ['Message usage', 'Sagebrush Farm', 'Fynbos & Finch', 'Engender Ltd', 'Mtnview Road', 'Absalom Street', 'Telkomsa-free']) {
      expect(findDeniedNames(ok).filter((h) => ['sage', 'dfa', 'mtn', 'engen', 'absa'].includes(h)), ok).toEqual([]);
    }
  });

  it('finds nothing in any fixture or in any generated string', () => {
    const fixtures = [
      ...CUSTOMERS.flatMap((c) => [c.name, c.contact, c.address, c.slug]),
      ...SUPPLIERS.flatMap((s) => [s.name, s.contact, s.line, s.slug]),
      ...ITEMS.map((i) => i.description), ...ASSETS.map((a) => a.name), ...SALES_LINES.map((l) => l.description),
      ...PRACTICE_CLIENTS.flatMap((p) => [p.legal, p.trading, p.contact]),
      ...EMPLOYEES.flatMap((e) => [e.firstName, e.lastName, e.occupation, e.department]),
    ];
    for (const f of fixtures) expect(findDeniedNames(f), f).toEqual([]);
    const d = generateDemoData(inputFor('2026-11-16', 7));
    for (const t of SEED_TABLES) {
      for (const r of d.rows[t]) {
        for (const [col, v] of Object.entries(r)) {
          if (typeof v === 'string' && !['explanation', 'component_breakdown', 'validation_results'].includes(col)) {
            expect(findDeniedNames(v), `${t}.${col}: ${v}`).toEqual([]);
          }
        }
      }
    }
  });

  it('keeps the brand spelling and no em dash in the new module and its tests', () => {
    for (const dir of ['scripts/lib/demoReseed', 'tests/unit/scripts/demoReseed']) {
      for (const f of readdirSync(dir).filter((x) => /\.(ts|md)$/.test(x))) {
        const src = readFileSync(join(dir, f), 'utf8');
        expect(WRONG_BRAND.test(src), f).toBe(false);
        expect(src.includes(String.fromCharCode(0x2014)), f).toBe(false);
      }
    }
  });
});
