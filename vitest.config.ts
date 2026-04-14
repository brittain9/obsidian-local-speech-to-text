import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: new URL('test/__mocks__/obsidian.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
