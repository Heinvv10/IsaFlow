export type { TaggedSql } from '../_pg';

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'INFO';

export type Finding = {
  journey: string;
  step: string;
  expected: string;
  actual: string;
  verdict: Verdict;
  evidence?: Record<string, unknown>;
  audit_claim?: string;
};

export class FindingsCollector {
  private items: Finding[] = [];

  record(f: Finding): void {
    this.items.push(f);
    const icon = f.verdict === 'PASS' ? 'OK ' : f.verdict === 'FAIL' ? 'FAIL' : f.verdict === 'BLOCKED' ? 'BLK' : 'i  ';
    console.log(`  [${icon}] ${f.step} — ${f.actual}`);
  }

  all(): Finding[] { return this.items; }

  summary(): { pass: number; fail: number; info: number; blocked: number } {
    return {
      pass: this.items.filter((f) => f.verdict === 'PASS').length,
      fail: this.items.filter((f) => f.verdict === 'FAIL').length,
      info: this.items.filter((f) => f.verdict === 'INFO').length,
      blocked: this.items.filter((f) => f.verdict === 'BLOCKED').length,
    };
  }
}
