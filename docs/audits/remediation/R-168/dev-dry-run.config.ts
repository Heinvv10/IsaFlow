import { defineConfig } from 'vitest/config';
import path from 'path';

const root = path.resolve(__dirname, '../../../..');
export default defineConfig({
  test: { environment: 'node', include: [path.join(__dirname, 'dev-dry-run.test.ts')], testTimeout: 600_000 },
  resolve: { alias: { '@': path.join(root, 'src') } },
});
