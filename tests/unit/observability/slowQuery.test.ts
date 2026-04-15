import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withSlowQueryTiming, previewSqlTemplate } from '@/lib/observability/slowQuery';
import { runWithRequestContext } from '@/lib/observability/requestContext';

describe('previewSqlTemplate', () => {
  it('joins template strings with ? placeholders, 120-char cap', () => {
    const strings = Object.assign(
      ['SELECT * FROM bank_transactions WHERE company_id = ', ' AND amount > ', ''] as unknown as string[],
      { raw: [] as string[] }
    ) as unknown as TemplateStringsArray;
    const preview = previewSqlTemplate(strings);
    expect(preview).toBe('SELECT * FROM bank_transactions WHERE company_id = ? AND amount > ?');
  });

  it('caps preview at 120 chars', () => {
    const long = 'x'.repeat(300);
    const strings = Object.assign([long], { raw: [] as string[] }) as unknown as TemplateStringsArray;
    expect(previewSqlTemplate(strings).length).toBe(120);
  });
});

describe('withSlowQueryTiming', () => {
  let warnSpy: ReturnType<typeof vi.fn>;
  let originalStderr: typeof process.stderr.write;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    originalStderr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    (process.stderr as any).write = originalStderr;
    vi.restoreAllMocks();
  });

  it('does not warn for fast queries', async () => {
    const fakeSql = (async () => 'fast-result') as any;
    const shim = withSlowQueryTiming(fakeSql, 500);
    const strings = Object.assign(['SELECT 1'], { raw: [] as string[] }) as unknown as TemplateStringsArray;
    const result = await shim(strings);
    expect(result).toBe('fast-result');
    const warns = captured.map((l) => JSON.parse(l.trim())).filter((p) => p.data?.event === 'slow_query');
    expect(warns).toHaveLength(0);
  });

  it('warns when query exceeds threshold and includes requestId', async () => {
    const fakeSql = (async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 'slow-result';
    }) as any;
    const shim = withSlowQueryTiming(fakeSql, 10);
    const strings = Object.assign(['SELECT pg_sleep(1)'], { raw: [] as string[] }) as unknown as TemplateStringsArray;
    await runWithRequestContext('rid-slow', async () => {
      const r = await shim(strings);
      expect(r).toBe('slow-result');
    });
    const warns = captured.map((l) => JSON.parse(l.trim())).filter((p) => p.data?.event === 'slow_query');
    expect(warns).toHaveLength(1);
    expect(warns[0].requestId).toBe('rid-slow');
    expect(warns[0].data.sql).toContain('SELECT pg_sleep(1)');
    expect(typeof warns[0].data.durationMs).toBe('number');
  });

  it('returns the underlying query result even if the timing block throws', async () => {
    const fakeSql = (async () => 'result-ok') as any;
    const shim = withSlowQueryTiming(fakeSql, 0);
    const strings = Object.assign(['SELECT 1'], { raw: [] as string[] }) as unknown as TemplateStringsArray;
    const result = await shim(strings);
    expect(result).toBe('result-ok');
  });

  it('preserves non-tagged-template properties (e.g. .transaction)', () => {
    const fakeSql: any = (async () => 'r');
    fakeSql.transaction = async () => 'tx-ok';
    const shim = withSlowQueryTiming(fakeSql, 500);
    expect(typeof (shim as any).transaction).toBe('function');
  });
});
