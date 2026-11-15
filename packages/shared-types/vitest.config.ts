import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['src/**/*.spec.ts'],
    typecheck: { enabled: true, include: ['src/**/*.test-d.ts'], tsconfig: './tsconfig.spec.json' },
  },
});
