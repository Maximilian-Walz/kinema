import { defineConfig } from 'vite';
// @ts-expect-error plain JS module, runs in Node only
import { studioPlugin } from './server/plugin.mjs';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 4321,
    strictPort: false,
  },
  plugins: [studioPlugin()],
});
