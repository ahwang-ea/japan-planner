import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../lib/db.js';

export const tripsRouter = Router();

// List all trips
tripsRouter.get('/', (_req, res) => {
  const trips = db.prepare('SELECT * FROM trips ORDER BY start_date DESC').all();
  res.json(trips);
});

// Get single trip with restaurants
tripsRouter.get('/:id', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!trip) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }

  const restaurants = db.prepare(`
    SELECT r.*, tr.sort_order, tr.day_assigned, tr.meal, tr.notes as trip_notes, tr.id as trip_restaurant_id
    FROM trip_restaurants tr
    JOIN restaurants r ON r.id = tr.restaurant_id
    WHERE tr.trip_id = ?
    ORDER BY tr.day_assigned ASC, tr.meal ASC, tr.sort_order ASC
  `).all(req.params.id);

  res.json({ ...trip, restaurants });
});

// Create trip
tripsRouter.post('/', (req, res) => {
  const id = uuid();
  const { name, city, start_date, end_date, notes } = req.body;

  if (!name || !start_date || !end_date) {
    res.status(400).json({ error: 'Name, start_date, and end_date are required' });
    return;
  }

  db.prepare(`
    INSERT INTO trips (id, name, city, start_date, end_date, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, city, start_date, end_date, notes);

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
  res.status(201).json(trip);
});

// Update trip
tripsRouter.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }

  const { name, city, start_date, end_date, is_active, notes } = req.body;

  // If setting this trip as active, deactivate all others
  if (is_active) {
    db.prepare('UPDATE trips SET is_active = 0').run();
  }

  db.prepare(`
    UPDATE trips SET name = ?, city = ?, start_date = ?, end_date = ?,
      is_active = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, city, start_date, end_date, is_active ? 1 : 0, notes, req.params.id);

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  res.json(trip);
});

// Delete trip
tripsRouter.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }

  db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Add restaurant to trip
tripsRouter.post('/:id/restaurants', (req, res) => {
  const { restaurant_id, day_assigned, meal } = req.body;
  if (!restaurant_id) {
    res.status(400).json({ error: 'restaurant_id is required' });
    return;
  }

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }

  const maxOrder = db.prepare(
    'SELECT MAX(sort_order) as max_order FROM trip_restaurants WHERE trip_id = ?'
  ).get(req.params.id) as { max_order: number | null };

  const id = uuid();
  const sortOrder = (maxOrder?.max_order ?? -1) + 1;

  try {
    db.prepare(`
      INSERT INTO trip_restaurants (id, trip_id, restaurant_id, sort_order, day_assigned, meal)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, restaurant_id, sortOrder, day_assigned || null, meal || null);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      // Restaurant already in trip — update the day/meal instead
      db.prepare(`
        UPDATE trip_restaurants SET day_assigned = ?, meal = ?
        WHERE trip_id = ? AND restaurant_id = ?
      `).run(day_assigned || null, meal || null, req.params.id, restaurant_id);
      res.json({ success: true, updated: true });
      return;
    }
    throw e;
  }

  res.status(201).json({ success: true });
});

// Remove restaurant from trip
tripsRouter.delete('/:id/restaurants/:restaurantId', (req, res) => {
  db.prepare(
    'DELETE FROM trip_restaurants WHERE trip_id = ? AND restaurant_id = ?'
  ).run(req.params.id, req.params.restaurantId);
  res.json({ success: true });
});
