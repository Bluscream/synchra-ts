import { defineConfig } from 'vitest/config';

/**
 * The live suite, run by `npm run test:live`. Separate from the default config on purpose: a test
 * that skips itself when the network or a credential is absent reports green, so the default gate
 * carries no skips and this one carries no excuses.
 *
 * `SYNCHRA_PUBLIC_CHANNEL_ID` is still required for the anonymous checks and `SYNCHRA_TOKEN` for
 * the authenticated ones — the suite fails loudly without them rather than passing quietly.
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
