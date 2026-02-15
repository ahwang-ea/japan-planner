import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../lib/db.js';

export const restaurantsRouter = Router();

// List all restaurants, sorted by tabelog_score desc
restaurantsRouter.get('/', (_req, res) => {
  const restaurants = db.prepare(`
    SELECT * FROM restaurants ORDER BY tabelog_score DESC NULLS LAST, name ASC
  `).all();
  res.json(restaurants);
});

// Browse Tabelog rankings by city (must be before /:id)
restaurantsRouter.get('/browse', async (req, res) => {
  const city = (req.query.city as string) || 'tokyo';
  const page = parseInt(req.query.page as string) || 1;

  try {
    const { browseTabelog, TABELOG_CITIES } = await import('../lib/scrapers/tabelog.js');

    if (req.query.cities === 'true') {
      res.json({ cities: Object.keys(TABELOG_CITIES) });
      return;
    }

    const refresh = req.query.refresh === 'true';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'rt';
    const svd = req.query.svd as string | undefined;
    const svt = req.query.svt as string | undefined;
    const svps = req.query.svps ? parseInt(req.query.svps as string) : undefined;
    const dateFilter = svd ? { date: svd, time: svt, partySize: svps } : undefined;
    const result = await browseTabelog(city, page, refresh, sort, dateFilter);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to browse Tabelog', details: String(error) });
  }
});

// Scrape single Tabelog URL
restaurantsRouter.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('tabelog.com')) {
    res.status(400).json({ error: 'Valid Tabelog URL is required' });
    return;
  }

  try {
    const { scrapeTabelog } = await import('../lib/scrapers/tabelog.js');
    const data = await scrapeTabelog(url);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to scrape Tabelog', details: String(error) });
  }
});

// Get single restaurant
restaurantsRouter.get('/:id', (req, res) => {
  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  if (!restaurant) {
    res.status(404).json({ error: 'Restaurant not found' });
    return;
  }
  res.json(restaurant);
});

// Create restaurant
restaurantsRouter.post('/', (req, res) => {
  const id = uuid();
  const {
    name, name_ja, tabelog_url, tabelog_score, cuisine, area, city,
    address, phone, price_range, hours, notes, rank,
    omakase_url, tablecheck_url, tableall_url, image_url
  } = req.body;

  if (!name) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  try {
    db.prepare(`
      INSERT INTO restaurants (id, name, name_ja, tabelog_url, tabelog_score, cuisine, area, city,
        address, phone, price_range, hours, notes, rank, omakase_url, tablecheck_url, tableall_url, image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, name_ja, tabelog_url, tabelog_score, cuisine, area, city,
      address, phone, price_range, hours, notes, rank, omakase_url, tablecheck_url, tableall_url, image_url);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('UNIQUE') && tabelog_url) {
      const existing = db.prepare('SELECT * FROM restaurants WHERE tabelog_url = ?').get(tabelog_url);
      res.json(existing);
      return;
    }
    throw e;
  }

  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(id);
  res.status(201).json(restaurant);
});

// Update restaurant
restaurantsRouter.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Restaurant not found' });
    return;
  }

  const {
    name, name_ja, tabelog_url, tabelog_score, cuisine, area, city,
    address, phone, price_range, hours, notes, rank,
    omakase_url, tablecheck_url, tableall_url, image_url
  } = req.body;

  db.prepare(`
    UPDATE restaurants SET
      name = ?, name_ja = ?, tabelog_url = ?, tabelog_score = ?, cuisine = ?, area = ?, city = ?,
      address = ?, phone = ?, price_range = ?, hours = ?, notes = ?, rank = ?,
      omakase_url = ?, tablecheck_url = ?, tableall_url = ?, image_url = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, name_ja, tabelog_url, tabelog_score, cuisine, area, city,
    address, phone, price_range, hours, notes, rank,
    omakase_url, tablecheck_url, tableall_url, image_url, req.params.id);

  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  res.json(restaurant);
});

// Toggle favorite
restaurantsRouter.patch('/:id/favorite', (req, res) => {
  const existing = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id) as { is_favorite: number } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Restaurant not found' });
    return;
  }

  db.prepare('UPDATE restaurants SET is_favorite = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(existing.is_favorite ? 0 : 1, req.params.id);

  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  res.json(restaurant);
});

// Delete restaurant
restaurantsRouter.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Restaurant not found' });
    return;
  }

  db.prepare('DELETE FROM restaurants WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

