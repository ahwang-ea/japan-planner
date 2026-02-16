import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { restaurantsRouter } from './routes/restaurants.js';
import { tripsRouter } from './routes/trips.js';
import { accountsRouter } from './routes/accounts.js';
import { availabilityRouter } from './routes/availability.js';

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/restaurants', restaurantsRouter);
app.use('/api/trips', tripsRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/availability', availabilityRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

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
  const port = await findOpenPort(preferred);
  app.listen(port, () => {
    fs.writeFileSync(PORT_FILE, String(port));
    console.log(`Server running on http://localhost:${port}`);
  });
}

start();
