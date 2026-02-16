CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_ja TEXT,
  tabelog_url TEXT UNIQUE,
  tabelog_score REAL,
  cuisine TEXT,
  area TEXT,
  city TEXT,
  address TEXT,
  phone TEXT,
  price_range TEXT,
  hours TEXT,
  notes TEXT,
  rank INTEGER,
  omakase_url TEXT,
  tablecheck_url TEXT,
  tableall_url TEXT,
  image_url TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trip_restaurants (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  day_assigned TEXT,
  meal TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'potential',
  booked_via TEXT,
  auto_dates INTEGER NOT NULL DEFAULT 0,
  UNIQUE(trip_id, restaurant_id, day_assigned, meal)
);

CREATE TABLE IF NOT EXISTS booking_accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  email TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  cookie_data TEXT,
  last_login_at TEXT,
  is_valid INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, email)
);

CREATE TABLE IF NOT EXISTS availability_results (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  check_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  time_slots TEXT,
  raw_data TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_availability_restaurant_trip
  ON availability_results(restaurant_id, trip_id, platform);
