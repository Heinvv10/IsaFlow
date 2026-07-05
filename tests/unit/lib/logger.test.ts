/**
 * N3 (A–Z baseline finding): the logger's JSON line serialized `Error`
 * objects inside `data` as `{}` — Error's message/stack are non-enumerable,
 * so JSON.stringify drops them. Every `log.error('...', { error: err })`
 * call site (the repo's standard pattern) was emitting useless `"error":{}`
 * to journald. These tests pin the fix: Errors serialize as
 * {name, message, stack} at any depth, and a data object that cannot be
 * stringified (circular) must never make the logger itself throw.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log } from '@/lib/logger';

function captureStream(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  return { lines, restore: () => spy.mockRestore() };
}

describe('logger Error serialization (N3)', () => {
  let stderr: ReturnType<typeof captureStream>;
  let stdout: ReturnType<typeof captureStream>;

  beforeEach(() => {
    stderr = captureStream(process.stderr);
    stdout = captureStream(process.stdout);
  });

  afterEach(() => {
    stderr.restore();
    stdout.restore();
  });

  it('serializes a top-level Error value with name, message and stack', () => {
    log.error('Failed to cancel invoice', { error: new Error('boom') }, 'test');
    const line = stderr.lines.find((l) => l.includes('Failed to cancel invoice'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!) as { data: { error: { name: string; message: string; stack?: string } } };
    expect(parsed.data.error.name).toBe('Error');
    expect(parsed.data.error.message).toBe('boom');
    expect(parsed.data.error.stack).toContain('boom');
  });

  it('keeps custom own-enumerable fields on Error subclasses (periodStatus-style)', () => {
    class ClosedPeriodStyleError extends Error {
      periodStatus: string;
      constructor(message: string, periodStatus: string) {
        super(message);
        this.name = 'ClosedPeriodStyleError';
        this.periodStatus = periodStatus;
      }
    }
    log.error('post failed', { error: new ClosedPeriodStyleError('period closed', 'locked') }, 'test');
    const line = stderr.lines.find((l) => l.includes('post failed'));
    const parsed = JSON.parse(line!) as {
      data: { error: { name: string; message: string; stack?: string; periodStatus: string } };
    };
    expect(parsed.data.error.name).toBe('ClosedPeriodStyleError');
    expect(parsed.data.error.message).toBe('period closed');
    expect(parsed.data.error.periodStatus).toBe('locked');
    expect(parsed.data.error.stack).toBeTruthy();
  });

  it('keeps requestId-free fallback shape valid but retains other payload fields on circular data', () => {
    const circular: Record<string, unknown> = { note: 'ring' };
    circular.self = circular;
    log.error('circ2', circular, 'mycomponent');
    const line = stderr.lines.find((l) => l.includes('circ2'));
    const parsed = JSON.parse(line!) as { component: string; level: string };
    expect(parsed.component).toBe('mycomponent');
    expect(parsed.level).toBe('error');
  });

  it('serializes a nested Error (inside an object inside data)', () => {
    log.error('outer', { ctx: { cause: new TypeError('deep failure') } }, 'test');
    const line = stderr.lines.find((l) => l.includes('outer'));
    const parsed = JSON.parse(line!) as { data: { ctx: { cause: { name: string; message: string } } } };
    expect(parsed.data.ctx.cause.name).toBe('TypeError');
    expect(parsed.data.ctx.cause.message).toBe('deep failure');
  });

  it('serializes Errors inside arrays', () => {
    log.warn('batch', { failures: [new Error('a'), new Error('b')] }, 'test');
    const line = stderr.lines.find((l) => l.includes('batch'));
    const parsed = JSON.parse(line!) as { data: { failures: Array<{ message: string }> } };
    expect(parsed.data.failures.map((f) => f.message)).toEqual(['a', 'b']);
  });

  it('never throws on circular data — emits a fallback line instead', () => {
    const circular: Record<string, unknown> = { message: 'ring' };
    circular.self = circular;
    expect(() => log.error('circular data', circular, 'test')).not.toThrow();
    const line = stderr.lines.find((l) => l.includes('circular data'));
    expect(line).toBeDefined();
    // The line itself must still be valid JSON (message survives, data degraded).
    expect(() => JSON.parse(line!)).not.toThrow();
  });

  it('plain data objects still serialize unchanged', () => {
    log.info('plain', { invoiceId: 'abc', total: 115 }, 'test');
    const line = stdout.lines.find((l) => l.includes('plain'));
    const parsed = JSON.parse(line!) as { data: { invoiceId: string; total: number } };
    expect(parsed.data).toEqual({ invoiceId: 'abc', total: 115 });
  });
});
