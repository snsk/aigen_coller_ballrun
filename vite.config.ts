import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/aigen_coller_ballrun/' : '/',
  server: {
    port: 5173,
    open: false,
  },
}));
