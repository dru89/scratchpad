import { defineConfig } from 'vite';

export default defineConfig({
  root: 'editor',
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
