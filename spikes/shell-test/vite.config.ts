import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  root: 'editor',
  base: './',
  // Dev server only, so the fixture isn't baked into the Tauri binary.
  publicDir: command === 'serve' ? '../fixtures' : false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
}));
