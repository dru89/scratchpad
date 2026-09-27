import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  base: './',
  build: { outDir: 'dist-renderer', emptyOutDir: true, target: 'es2022' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: { include: ['src/**/*.test.ts', 'electron/**/*.test.ts'] },
});
