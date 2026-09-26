import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { outDir: 'dist-renderer', emptyOutDir: true, target: 'es2022' },
  test: { include: ['src/**/*.test.ts'] },
});
