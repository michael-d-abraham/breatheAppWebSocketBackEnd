import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // Vite dev server (UI). WebSocket API runs on 8085 via `npm start` (server/index.js).
  server: {
    port: 5173,
    strictPort: false,
  },
});
