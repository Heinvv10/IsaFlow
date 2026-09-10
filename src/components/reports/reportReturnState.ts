/** Report navigation accepts only the originating report and its known controls. */
type Query = Record<string, string | string[] | undefined>;
export const queryText = (query: Query, key: string): string =>
  typeof query[key] === 'string' ? query[key] : '';

const fields = {
  tb: ['fiscal_period_id', 'compare_period_id', 'cost_centre_id', 'business_unit_id', 'show_movement', 'from', 'to'],
  bs: ['as_at_date', 'cost_centre_id', 'prior', 'variance', 'trend'],
};
export function reportHref(source: 'tb' | 'bs', query: Query): string {
  const params = new URLSearchParams();
  for (const key of fields[source]) {
    const value = queryText(query, key);
    if (value) params.set(key, value);
  }
  const path = source === 'bs' ? '/accounting/reports/balance-sheet' : '/accounting/trial-balance';
  return path + (params.size ? `?${params}` : '');
}

export function accountReportBackHref(query: Query): string {
  const source = query.source === 'bs' ? 'bs' : 'tb';
  const fallback = reportHref(source, {
    cost_centre_id: query.cost_centre_id, business_unit_id: query.business_unit_id,
    as_at_date: query.to, from: query.from, to: query.to,
  });
  const returnTo = queryText(query, 'return_to');
  if (!returnTo) return fallback;
  try {
    const url = new URL(returnTo, 'https://report.invalid');
    const expectedPath = reportHref(source, {});
    if (url.origin !== 'https://report.invalid' || url.pathname !== expectedPath) return fallback;
    const clean: Query = {};
    for (const key of fields[source]) {
      const values = url.searchParams.getAll(key);
      if (values.length === 1) clean[key] = values[0];
    }
    return reportHref(source, clean);
  } catch { return fallback; }
}
