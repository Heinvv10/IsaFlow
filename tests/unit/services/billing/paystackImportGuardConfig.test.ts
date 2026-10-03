/**
 * R-183: the ESLint rules that keep callers on the paystackClient barrel live in flat config, where a
 * later block that sets no-restricted-imports / no-restricted-syntax REPLACES their options. Resolve
 * the effective config for ordinary files and assert the R-183 entries survive.
 */

import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

const FILES = ['src/modules/billing/services/subscriptionBillingService.ts', 'pages/api/billing/flows/purchase.ts'];

/** Effective [severity, ...options] as JSON; severity 2 = error, 0 = off. */
async function ruleOptions(file: string, rule: string): Promise<string> {
  const config = await new ESLint().calculateConfigForFile(file);
  return JSON.stringify(config?.rules?.[rule] ?? null);
}

describe('R-183 paystack import guard — effective ESLint config', () => {
  it.each(FILES)('%s forbids importing the parts', async (file) => {
    const imports = await ruleOptions(file, 'no-restricted-imports');
    for (const part of ['paystackHttp', 'paystackTransactions', 'paystackSubscriptions']) {
      expect(imports).toContain(part);
    }
    expect(imports.startsWith('[2,')).toBe(true);
  });

  it.each(FILES)('%s forbids dynamic import() of the parts', async (file) => {
    const syntax = await ruleOptions(file, 'no-restricted-syntax');
    expect(syntax).toContain('ImportExpression[source.value=');
    expect(syntax).toContain('ImportExpression > TemplateLiteral.source > TemplateElement');
    expect(syntax.startsWith('[2,')).toBe(true);
  });

  it('the barrel and the parts are exempt', async () => {
    const imports = await ruleOptions('src/modules/billing/services/paystackClient.ts', 'no-restricted-imports');
    expect(imports.startsWith('[0')).toBe(true);
  });
});
