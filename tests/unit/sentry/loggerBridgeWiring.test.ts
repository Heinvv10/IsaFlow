import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fwd = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sentry/logBridge', () => ({ forwardLogError: fwd }));
import { Logger } from '@/lib/logger';

beforeEach(() => {
  fwd.mockClear();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('logger -> bridge wiring', () => {
  it('is a no-op under test', () => {
    new Logger().error('boom', {}, 'C');
    expect(fwd).not.toHaveBeenCalled();
  });
  it('forwards error-level calls outside tests, with component', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', '');
    const l = new Logger();
    l.error('boom', { a: 1 }, 'C');
    l.warn('careful', {}, 'C');
    l.info('fine', {}, 'C');
    expect(fwd).toHaveBeenCalledTimes(1);
    expect(fwd.mock.calls[0][0]).toMatchObject({ message: 'boom', component: 'C', data: { a: 1 } });
  });
});
