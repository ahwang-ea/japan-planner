import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root (one level above server/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import express from 'express';
import cors from 'cors';
import net from 'net';
import fs from 'fs';
import { restaurantsRouter } from './routes/restaurants.js';
import { tripsRouter } from './routes/trips.js';
import { accountsRouter } from './routes/accounts.js';
import { availabilityRouter } from './routes/availability.js';

const app = express();

app.use(cors());
app.use(express.json());

// In production, serve the built React frontend
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

// Routes
app.use('/api/restaurants', restaurantsRouter);
app.use('/api/trips', tripsRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/availability', availabilityRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// SPA fallback: serve index.html for non-API routes
if (fs.existsSync(clientDist)) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

function findOpenPort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      resolve(findOpenPort(start + 1));
    });
    server.listen(start, () => {
      server.close(() => resolve(start));
    });
  });
}

const PORT_FILE = path.join(import.meta.dirname, '../../.port');

async function start() {
  const preferred = parseInt(process.env.PORT || '3100', 10);
  // In production (Railway), use PORT directly. In dev, find an open port.
  const port = process.env.NODE_ENV === 'production' ? preferred : await findOpenPort(preferred);
  app.listen(port, () => {
    fs.writeFileSync(PORT_FILE, String(port));
    console.log(`Server running on http://localhost:${port}`);
    console.log(`  SERPER_API_KEY: ${process.env.SERPER_API_KEY ? 'loaded (' + process.env.SERPER_API_KEY.slice(0, 6) + '...)' : 'NOT SET — platform discovery disabled'}`);
    if (fs.existsSync(clientDist)) {
      console.log(`  Serving frontend from ${clientDist}`);
    }
  });
}

start();
