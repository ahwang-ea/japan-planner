import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';

function getServerPort(): number {
  try {
    const portFile = path.join(__dirname, '../server/.port');
    return parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
  } catch {
    return 3100; // fallback
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5200,
    strictPort: false, // auto-increment if 5200 is taken
    proxy: {
      '/api': `http://localhost:${getServerPort()}`,
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
