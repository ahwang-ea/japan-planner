import { Router } from 'express';
import db from '../lib/db.js';

export const availabilityRouter = Router();

// Get availability results for a restaurant + trip
availabilityRouter.get('/', (req, res) => {
  const { restaurant_id, trip_id } = req.query;

  let query = 'SELECT * FROM availability_results WHERE 1=1';
  const params: unknown[] = [];

  if (restaurant_id) {
    query += ' AND restaurant_id = ?';
    params.push(restaurant_id);
  }
  if (trip_id) {
    query += ' AND trip_id = ?';
    params.push(trip_id);
  }

  query += ' ORDER BY check_date ASC, platform ASC';

  const results = db.prepare(query).all(...params);
  res.json(results);
});
