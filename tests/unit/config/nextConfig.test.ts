import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const nextConfig = require('../../../next.config.js') as {
  images?: { unoptimized?: boolean };
};

describe('Next image security stop-gap', () => {
  it('disables the vulnerable Next 14 image optimizer', () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });
});
