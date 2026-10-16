import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { middleware } from '../../middleware';

const returnToOf = async (url: string) => {
  const req = new NextRequest(url, { headers: { host: new URL(url).host } });
  const res = await middleware(req);
  return new URL(res.headers.get('location')!).searchParams.get('returnTo');
};

it('admin host: a logged-out deep link keeps its query string in returnTo', async () => {
  expect(await returnToOf('https://admin.isaflow.co.za/admin/billing/subscriptions?companyId=abc'))
    .toBe('/admin/billing/subscriptions?companyId=abc');
});

it('app host: a logged-out deep link keeps its query string in returnTo', async () => {
  expect(await returnToOf('https://app.isaflow.co.za/accounting/reports/balance-sheet?as_at_date=2026-04-30'))
    .toBe('/accounting/reports/balance-sheet?as_at_date=2026-04-30');
});

it('a deep link without a query string is unchanged', async () => {
  expect(await returnToOf('https://admin.isaflow.co.za/admin/companies')).toBe('/admin/companies');
});
