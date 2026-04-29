import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      clean: true,
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'src/**/*.test.ts',
        'src/index.ts',
        'src/cli/**',
      ],
    },
  },
});
