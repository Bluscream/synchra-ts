import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // The generated layer is types and thin request builders; coverage of it measures the
      // generator, which has its own tests.
      exclude: ['src/generated/**', 'tools/**', 'examples/**', 'dist/**', '*.config.ts'],
    },
  },
});
