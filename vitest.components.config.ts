import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // tsconfig sets `jsx: "preserve"` for Next.js, so without this plugin Vite
  // refuses every .tsx this config's `include` is here to run.
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['tests/unit/components/setup.ts'],
    include: ['tests/unit/components/**/*.test.tsx', 'tests/unit/components/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: {
      // see tests/stubs/nextFontGoogle.ts — next/font is a build-time
      // transform vitest does not apply, so the real export is not callable
      'next/font/google': path.resolve(__dirname, './tests/stubs/nextFontGoogle.ts'),
      '@': path.resolve(__dirname, './src'),
    },
  },
});
