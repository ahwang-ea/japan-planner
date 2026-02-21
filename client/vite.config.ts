import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';
import os from 'os';

function getServerPort(): number {
  try {
    const portFile = path.join(__dirname, '../.port');
    return parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
  } catch {
    return 3100; // fallback
  }
}

function getLocalIP(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

function qrCodePlugin(): PluginOption {
  let printed = false;
  return {
    name: 'vite-plugin-qr',
    configureServer(server) {
      server.httpServer?.on('listening', async () => {
        if (printed) return;
        printed = true;
        const ip = getLocalIP();
        const address = server.httpServer?.address();
        if (!ip || !address || typeof address === 'string') return;
        const url = `http://${ip}:${address.port}`;
        try {
          const qr = await import('qrcode-terminal');
          console.log(`\n  📱 Scan to open on your phone:\n`);
          qr.default.generate(url, { small: true }, (code: string) => {
            console.log(code);
            console.log(`  ${url}\n`);
          });
        } catch {}
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), qrCodePlugin()],
  server: {
    host: true, // expose on local network for mobile testing
    port: 5200,
    strictPort: false, // auto-increment if 5200 is taken
    proxy: {
      '/api': {
        target: `http://localhost:${getServerPort()}`,
        timeout: 120000, // 2 min — Tabelog scrapes can be slow on first load
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
