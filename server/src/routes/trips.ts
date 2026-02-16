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
    SELECT r.*, tr.sort_order, tr.day_assigned, tr.meal, tr.notes as trip_notes,
           tr.id as trip_restaurant_id, tr.status, tr.booked_via, tr.auto_dates
    FROM trip_restaurants tr
    JOIN restaurants r ON r.id = tr.restaurant_id
    WHERE tr.trip_id = ?
    ORDER BY tr.day_assigned ASC, tr.meal ASC,
             CASE tr.status WHEN 'booked' THEN 0 ELSE 1 END,
             tr.sort_order ASC
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
  const { restaurant_id, day_assigned, meal, status, booked_via, auto_dates } = req.body;
  if (!restaurant_id) {
    res.status(400).json({ error: 'restaurant_id is required' });
    return;
  }

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }

  const bookingStatus = status || 'potential';
  const via = bookingStatus === 'booked' ? (booked_via || null) : null;

  // If booking, check no existing booking for this slot
  if (bookingStatus === 'booked' && day_assigned && meal) {
    const existing = db.prepare(
      `SELECT id FROM trip_restaurants
       WHERE trip_id = ? AND day_assigned = ? AND meal = ? AND status = 'booked'`
    ).get(req.params.id, day_assigned, meal) as { id: string } | undefined;
    if (existing) {
      // Auto-demote existing booking to potential
      db.prepare(`UPDATE trip_restaurants SET status = 'potential', booked_via = NULL WHERE id = ?`).run(existing.id);
    }
  }

  const maxOrder = db.prepare(
    'SELECT MAX(sort_order) as max_order FROM trip_restaurants WHERE trip_id = ?'
  ).get(req.params.id) as { max_order: number | null };

  const id = uuid();
  const sortOrder = (maxOrder?.max_order ?? -1) + 1;

  // SQLite treats NULLs as distinct in UNIQUE constraints, so check manually when day/meal are NULL
  const dayVal = day_assigned || null;
  const mealVal = meal || null;
  const existing = db.prepare(`
    SELECT id FROM trip_restaurants
    WHERE trip_id = ? AND restaurant_id = ? AND day_assigned IS ? AND meal IS ?
  `).get(req.params.id, restaurant_id, dayVal, mealVal) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE trip_restaurants SET status = ?, booked_via = ?, auto_dates = ?
      WHERE id = ?
    `).run(bookingStatus, via, auto_dates ? 1 : 0, existing.id);
    res.json({ success: true, updated: true });
    return;
  }

  db.prepare(`
    INSERT INTO trip_restaurants (id, trip_id, restaurant_id, sort_order, day_assigned, meal, status, booked_via, auto_dates)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, restaurant_id, sortOrder, dayVal, mealVal, bookingStatus, via, auto_dates ? 1 : 0);

  res.status(201).json({ success: true, id });
});

// Change booking status of a trip restaurant
tripsRouter.patch('/:id/restaurants/:trId/status', (req, res) => {
  const { status, booked_via } = req.body;
  if (!status || (status !== 'booked' && status !== 'potential')) {
    res.status(400).json({ error: "status must be 'booked' or 'potential'" });
    return;
  }

  const tr = db.prepare('SELECT * FROM trip_restaurants WHERE id = ? AND trip_id = ?')
    .get(req.params.trId, req.params.id) as Record<string, unknown> | undefined;
  if (!tr) {
    res.status(404).json({ error: 'Trip restaurant not found' });
    return;
  }

  if (status === 'booked' && tr.day_assigned && tr.meal) {
    // Demote any existing booking for this slot to potential
    db.prepare(`
      UPDATE trip_restaurants SET status = 'potential', booked_via = NULL
      WHERE trip_id = ? AND day_assigned = ? AND meal = ? AND status = 'booked' AND id != ?
    `).run(req.params.id, tr.day_assigned, tr.meal, req.params.trId);
  }

  const via = status === 'booked' ? (booked_via || null) : null;
  db.prepare('UPDATE trip_restaurants SET status = ?, booked_via = ? WHERE id = ?')
    .run(status, via, req.params.trId);

  res.json({ success: true });
});

// Move a trip restaurant to a different day/meal
tripsRouter.patch('/:id/restaurants/:trId/assign', (req, res) => {
  const { day_assigned, meal } = req.body;

  const tr = db.prepare('SELECT * FROM trip_restaurants WHERE id = ? AND trip_id = ?')
    .get(req.params.trId, req.params.id) as Record<string, unknown> | undefined;
  if (!tr) {
    res.status(404).json({ error: 'Trip restaurant not found' });
    return;
  }

  // If this is a booked restaurant moving to a slot that already has a booking, demote the existing
  if (tr.status === 'booked' && day_assigned && meal) {
    db.prepare(`
      UPDATE trip_restaurants SET status = 'potential', booked_via = NULL
      WHERE trip_id = ? AND day_assigned = ? AND meal = ? AND status = 'booked' AND id != ?
    `).run(req.params.id, day_assigned, meal, req.params.trId);
  }

  db.prepare(`
    UPDATE trip_restaurants SET day_assigned = ?, meal = ?
    WHERE id = ? AND trip_id = ?
  `).run(day_assigned || null, meal || null, req.params.trId, req.params.id);

  res.json({ success: true });
});

// Delete a trip restaurant by its row ID
tripsRouter.delete('/:id/trip-restaurants/:trId', (req, res) => {
  db.prepare('DELETE FROM trip_restaurants WHERE id = ? AND trip_id = ?')
    .run(req.params.trId, req.params.id);
  res.json({ success: true });
});

// Remove restaurant from trip (legacy — removes ALL rows for this restaurant)
tripsRouter.delete('/:id/restaurants/:restaurantId', (req, res) => {
  db.prepare(
    'DELETE FROM trip_restaurants WHERE trip_id = ? AND restaurant_id = ?'
  ).run(req.params.id, req.params.restaurantId);
  res.json({ success: true });
});

// Optimize trip restaurant assignments
interface TripRestaurantRow {
  id: string;
  trip_id: string;
  restaurant_id: string;
  day_assigned: string | null;
  meal: string | null;
  status: string;
  tabelog_url: string | null;
  name: string;
}

interface SuggestionAction {
  trId: string;
  restaurantName: string;
  from: { day: string; meal: string };
  to: { day: string; meal: string };
}

interface Suggestion {
  type: 'swap' | 'move' | 'conflict';
  description: string;
  actions: SuggestionAction[];
}

interface AvailabilityInput {
  dates: { date: string; status: string }[];
}

function computeSuggestions(
  tripRestaurants: TripRestaurantRow[],
  availability: Record<string, AvailabilityInput>
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const scheduled = tripRestaurants.filter(tr => tr.day_assigned && tr.meal);

  // Build slot map: "date|meal" -> rows
  const slotMap = new Map<string, TripRestaurantRow[]>();
  for (const tr of scheduled) {
    const key = `${tr.day_assigned}|${tr.meal}`;
    if (!slotMap.has(key)) slotMap.set(key, []);
    slotMap.get(key)!.push(tr);
  }

  // Build availability lookup: restaurant_id -> Set<date> where available
  const availDates = new Map<string, Set<string>>();
  for (const tr of scheduled) {
    if (!tr.tabelog_url || !availability[tr.tabelog_url]) continue;
    const dates = availability[tr.tabelog_url].dates
      .filter(d => d.status === 'available' || d.status === 'limited')
      .map(d => d.date);
    availDates.set(tr.restaurant_id, new Set(dates));
  }

  const seen = new Set<string>();

  // Pattern 1: Crowded slot relief — move a potential to a less-crowded date
  for (const [slotKey, restaurants] of slotMap) {
    if (restaurants.length <= 1) continue;
    const [day, meal] = slotKey.split('|');

    for (const tr of restaurants) {
      if (tr.status === 'booked') continue; // don't suggest moving booked ones
      const avail = availDates.get(tr.restaurant_id);
      if (!avail) continue;

      for (const altDate of avail) {
        if (altDate === day) continue;
        const altKey = `${altDate}|${meal}`;
        const altSlot = slotMap.get(altKey) || [];
        if (altSlot.length === 0) {
          const key = `move:${tr.id}:${altDate}`;
          if (seen.has(key)) continue;
          seen.add(key);
          suggestions.push({
            type: 'move',
            description: `Move "${tr.name}" to ${altDate} ${meal} — frees up ${day} (${restaurants.length} potentials competing)`,
            actions: [{ trId: tr.id, restaurantName: tr.name, from: { day: day!, meal: meal! }, to: { day: altDate, meal: meal! } }],
          });
          break; // one suggestion per restaurant
        }
      }
    }
  }

  // Pattern 2: Unavailability conflict — restaurant on a date it's NOT available
  for (const tr of scheduled) {
    if (tr.status === 'booked') continue;
    const avail = availDates.get(tr.restaurant_id);
    if (!avail || avail.size === 0) continue;
    if (avail.has(tr.day_assigned!)) continue; // it IS available, no conflict

    const alternatives = [...avail].filter(d => {
      const altKey = `${d}|${tr.meal}`;
      const altSlot = slotMap.get(altKey) || [];
      return altSlot.length === 0;
    }).slice(0, 3);

    if (alternatives.length > 0) {
      const key = `conflict:${tr.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({
        type: 'conflict',
        description: `"${tr.name}" is unavailable on ${tr.day_assigned} — available on ${alternatives.join(', ')} instead`,
        actions: [{ trId: tr.id, restaurantName: tr.name, from: { day: tr.day_assigned!, meal: tr.meal! }, to: { day: alternatives[0]!, meal: tr.meal! } }],
      });
    }
  }

  return suggestions;
}

tripsRouter.post('/:id/optimize', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }

  const tripRestaurants = db.prepare(`
    SELECT tr.*, r.tabelog_url, r.name
    FROM trip_restaurants tr
    JOIN restaurants r ON r.id = tr.restaurant_id
    WHERE tr.trip_id = ?
  `).all(req.params.id) as TripRestaurantRow[];

  const { availability } = req.body as { availability: Record<string, AvailabilityInput> };
  const suggestions = computeSuggestions(tripRestaurants, availability || {});
  res.json({ suggestions });
});

// Toggle auto_dates flag on a trip restaurant
tripsRouter.patch('/:id/restaurants/:trId/auto-dates', (req, res) => {
  const tr = db.prepare('SELECT * FROM trip_restaurants WHERE id = ? AND trip_id = ?')
    .get(req.params.trId, req.params.id) as Record<string, unknown> | undefined;
  if (!tr) {
    res.status(404).json({ error: 'Trip restaurant not found' });
    return;
  }

  const auto_dates = req.body.auto_dates ? 1 : 0;
  db.prepare('UPDATE trip_restaurants SET auto_dates = ? WHERE id = ?')
    .run(auto_dates, req.params.trId);

  res.json({ success: true });
});

// Sync auto_dates restaurant entries with availability data
tripsRouter.post('/:id/restaurants/sync', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!trip) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }

  const { restaurant_id, availability, meal } = req.body as {
    restaurant_id: string;
    availability: { dates: { date: string; status: string }[] };
    meal?: 'lunch' | 'dinner' | null;
  };

  if (!restaurant_id || !availability?.dates) {
    res.status(400).json({ error: 'restaurant_id and availability.dates are required' });
    return;
  }

  // Compute bookable dates within trip date range
  const bookableDates = new Set(
    availability.dates
      .filter(d => (d.status === 'available' || d.status === 'limited') &&
                   d.date >= (trip.start_date as string) && d.date <= (trip.end_date as string))
      .map(d => d.date)
  );

  const meals: string[] = meal ? [meal] : ['lunch', 'dinner'];
  const added: string[] = [];
  const removed: string[] = [];

  const maxOrder = db.prepare(
    'SELECT MAX(sort_order) as max_order FROM trip_restaurants WHERE trip_id = ?'
  ).get(req.params.id) as { max_order: number | null };
  let sortOrder = (maxOrder?.max_order ?? -1) + 1;

  for (const m of meals) {
    // Get existing auto_dates rows for this restaurant+trip+meal
    const existing = db.prepare(`
      SELECT id, day_assigned FROM trip_restaurants
      WHERE trip_id = ? AND restaurant_id = ? AND meal = ? AND auto_dates = 1 AND status = 'potential'
    `).all(req.params.id, restaurant_id, m) as { id: string; day_assigned: string | null }[];

    const existingDates = new Set(existing.map(r => r.day_assigned).filter(Boolean));

    // Add new rows for bookable dates that don't exist
    for (const date of bookableDates) {
      if (!existingDates.has(date)) {
        const id = uuid();
        try {
          db.prepare(`
            INSERT INTO trip_restaurants (id, trip_id, restaurant_id, sort_order, day_assigned, meal, status, auto_dates)
            VALUES (?, ?, ?, ?, ?, ?, 'potential', 1)
          `).run(id, req.params.id, restaurant_id, sortOrder++, date, m);
          added.push(`${date} ${m}`);
        } catch (e: unknown) {
          if (e instanceof Error && e.message.includes('UNIQUE')) continue;
          throw e;
        }
      }
    }

    // Remove rows for dates that are no longer available
    for (const row of existing) {
      if (row.day_assigned && !bookableDates.has(row.day_assigned)) {
        db.prepare('DELETE FROM trip_restaurants WHERE id = ?').run(row.id);
        removed.push(`${row.day_assigned} ${m}`);
      }
    }
  }

  res.json({ added, removed });
});
