import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.DATABASE_PATH || './data/japan-planner.db';
const dbDir = path.dirname(dbPath);

// Ensure the data directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema on startup
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// Migrations for existing databases
try { db.exec('ALTER TABLE restaurants ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE restaurants ADD COLUMN image_url TEXT'); } catch {}
try { db.exec('ALTER TABLE trip_restaurants ADD COLUMN meal TEXT'); } catch {}

// Migration: add status + booked_via columns and change UNIQUE constraint on trip_restaurants
try {
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trip_restaurants' AND type = 'table'").get() as { sql: string } | undefined;
  if (info && info.sql.includes('UNIQUE(trip_id, restaurant_id)') && !info.sql.includes('UNIQUE(trip_id, restaurant_id, day_assigned, meal)')) {
    db.exec(`
      CREATE TABLE trip_restaurants_new (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        day_assigned TEXT,
        meal TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'potential',
        booked_via TEXT,
        UNIQUE(trip_id, restaurant_id, day_assigned, meal)
      );
      INSERT INTO trip_restaurants_new (id, trip_id, restaurant_id, sort_order, day_assigned, meal, notes, status, booked_via)
        SELECT id, trip_id, restaurant_id, sort_order, day_assigned, meal, notes, 'potential', NULL FROM trip_restaurants;
      DROP TABLE trip_restaurants;
      ALTER TABLE trip_restaurants_new RENAME TO trip_restaurants;
    `);
  }
} catch {}

// Migration: add auto_dates column
try { db.exec('ALTER TABLE trip_restaurants ADD COLUMN auto_dates INTEGER NOT NULL DEFAULT 0'); } catch {}

export default db;
