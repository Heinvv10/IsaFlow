/**
 * The migration wizard's one CSV reader.
 *
 * `comments: '#'`: templates downloaded before the guidance moved out of the
 * file carry `# ...` lines, and Papa read each one as a data row — a customer
 * called "# name: required". Skipping them keeps those files importable.
 * `skipEmptyLines: 'greedy'` also drops rows of only blank cells (",,,,"),
 * which spreadsheet exports append.
 */
export interface ParsedCsv {
  data: Array<Record<string, string>>;
  fields: string[];
}

export async function parseMigrationCsv(input: File | string): Promise<ParsedCsv> {
  // Loaded on demand, as the pages always did: papaparse stays out of the page bundle.
  const papa = (await import('papaparse')).default;
  const base = {
    header: true as const,
    skipEmptyLines: 'greedy' as const,
    comments: '#',
    transformHeader: (h: string) => h.trim(),
  };
  if (typeof input === 'string') {
    const r = papa.parse<Record<string, string>>(input, base);
    return { data: r.data, fields: r.meta.fields ?? [] };
  }
  return new Promise((resolve, reject) => {
    papa.parse<Record<string, string>>(input, {
      ...base,
      complete: ({ data, meta }) => resolve({ data, fields: meta.fields ?? [] }),
      error: (err: Error) => reject(err),
    });
  });
}
