import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The live suite has its own config and npm script; it talks to api.synchra.net.
    exclude: ['test/live/**'],
    coverage: {
      provider: 'v8',
      // The generated layer is types and thin request builders; coverage of it measures the
      // generator, which has its own tests.
      exclude: ['src/generated/**', 'tools/**', 'examples/**', 'dist/**', '*.config.ts'],
    },
  },
});
