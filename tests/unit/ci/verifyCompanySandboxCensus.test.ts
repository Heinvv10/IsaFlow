// Every spec the production verify run executes (not // golden:dev-only, playwright-golden.config.ts) that CREATES a company must have
// that company pre-created and is_demo by the provisioner (scripts/deploy/verifyCompany/sandboxes.ts). A spec that makes a company
// of its own would leave one that is not is_demo on the verify login, and the suite's global setup would fail the next run red.
// Census by spec: a spec's own code and every file it imports (relative, transitively) is read as text.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allSpecFiles, devOnlySpecFiles } from '../../e2e/golden-paths/helpers/devOnlySpecs';
import { PRECREATED_SANDBOXES } from '../../../scripts/deploy/verifyCompany/sandboxes';
import { buildBlocks } from '../../../scripts/deploy/verifyCompany/seedBlocks';

const DIR = path.resolve(__dirname, '../../e2e/golden-paths');
/** The ways a golden spec brings a company into being: the shared find-or-create, the onboarding route, its request body, the autosave fixture, the SQL function. */
const CREATES = /findOrCreateSandbox|findOrCreateMigrationSandbox|complete-setup|sandboxSetupBody|invoiceAutosaveFixture|create_company_with_owner/;

/** The files in `file`'s import closure (itself included) that match CREATES. */
function creators(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  const out = CREATES.test(src) ? [file] : [];
  for (const m of src.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), m[1]!);
    for (const c of [`${base}.ts`, `${base}/index.ts`]) if (existsSync(c)) out.push(...creators(c, seen));
  }
  return out;
}

/** The specs production verify runs, given the dev-only specs: every spec file but those. */
const prodSpecs = (devOnly: Set<string>): string[] => allSpecFiles(DIR).filter((f) => !devOnly.has(f));
const creatingSpecs = (devOnly: Set<string>): string[] => prodSpecs(devOnly).filter((f) => creators(path.join(DIR, f)).length > 0);

describe('sandbox companies of the production verify run', () => {
  const devOnly = new Set(devOnlySpecFiles(DIR));

  it('the production run is the 24 non-dev-only specs the verify docs name', () => {
    expect(prodSpecs(devOnly)).toHaveLength(24);
  });

  it('every prod spec that creates a company is in the provisioner\'s pre-created list, and nothing else is', () => {
    expect(creatingSpecs(devOnly).sort()).toEqual(PRECREATED_SANDBOXES.map((s) => s.spec).sort());
  });

  it('each listed sandbox is named by that spec\'s own code, through the listed symbol, and the provisioner has a block for it', () => {
    for (const sb of PRECREATED_SANDBOXES) {
      expect(prodSpecs(devOnly)).toContain(sb.spec);
      const code = [path.join(DIR, sb.spec), ...creators(path.join(DIR, sb.spec))].map((f) => readFileSync(f, 'utf8')).join('\n');
      expect(code, `${sb.spec} must name its sandbox through ${sb.symbol}`).toContain(sb.symbol);
      expect(buildBlocks().map((b) => b.name)).toContain(`sandbox company "${sb.name}"`);
    }
  });

  it('a spec marked dev-only that creates companies is not production\'s concern: the dev-only sandbox specs exist and are excluded', () => {
    const devCreators = [...devOnly].filter((f) => creators(path.join(DIR, f)).length > 0);
    expect(devCreators.length).toBeGreaterThan(5);
  });

  it('dropping the dev-only marker from any sandbox-creating dev-only spec turns the census red (what the census exists to catch)', () => {
    const devCreators = [...devOnly].filter((f) => creators(path.join(DIR, f)).length > 0);
    for (const f of devCreators) {
      const without = new Set([...devOnly].filter((x) => x !== f));
      expect(creatingSpecs(without).sort(), `${f} without its dev-only marker`).not.toEqual(PRECREATED_SANDBOXES.map((s) => s.spec).sort());
    }
  });
});
