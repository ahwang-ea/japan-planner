import fs from 'fs';
import path from 'path';
import { getBrowser, UA } from './tabelog.js';

export interface TableCheckRestaurant {
  name: string;
  tablecheck_url: string;
  tablecheck_slug: string;
  image_url: string | null;
  price_range: string | null;
  cuisine: string | null;
  available_dates: string[];
  time_slots: Record<string, string[]>; // date → available times
}

export interface TableCheckSearchResult {
  restaurants: TableCheckRestaurant[];
  dateFrom: string;
  dateTo: string;
}

// City → approximate center coordinates
const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  tokyo: { lat: 35.6897, lng: 139.6922 },
  osaka: { lat: 34.6937, lng: 135.5023 },
  kyoto: { lat: 35.0116, lng: 135.7681 },
  fukuoka: { lat: 33.5904, lng: 130.4017 },
  sapporo: { lat: 43.0618, lng: 141.3545 },
  nagoya: { lat: 35.1815, lng: 136.9066 },
  yokohama: { lat: 35.4437, lng: 139.6380 },
  kobe: { lat: 34.6901, lng: 135.1956 },
  hiroshima: { lat: 34.3853, lng: 132.4553 },
  nara: { lat: 34.6851, lng: 135.8048 },
};

// File-backed cache with 4-hour TTL
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const CACHE_FILE = path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'tablecheck-search-cache.json',
);

type CacheEntry = { data: TableCheckSearchResult; timestamp: number };
let searchCache = new Map<string, CacheEntry>();

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, CacheEntry>;
      searchCache = new Map(Object.entries(raw));
    }
  } catch { /* ignore corrupt cache */ }
}

function saveCache() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(searchCache)));
  } catch { /* non-critical */ }
}

loadCache();

function buildSearchUrl(date: string, city: string, partySize: number, time: string): string {
  const coords = CITY_COORDS[city.toLowerCase()] || CITY_COORDS.tokyo;
  const params = new URLSearchParams({
    service_mode: 'dining',
    sort_by: 'relevance',
    venue_type: 'tc',
    geo_latitude: String(coords.lat),
    geo_longitude: String(coords.lng),
    auto_geolocate: 'false',
    geo_distance: '5km',
    date,
    num_people: String(partySize),
    time,
    availability_mode: 'same_meal_time',
    availability_format: 'datetime',
    sort_order: 'asc',
  });
  return `https://www.tablecheck.com/en/japan/search?${params.toString()}`;
}

async function scrapeSearchPage(
  date: string,
  city: string,
  partySize: number,
  time: string,
): Promise<{ slug: string; name: string; cuisine: string; dinnerPrice: string | null; lunchPrice: string | null; timeSlots: string[]; imageUrl: string | null }[]> {
  const url = buildSearchUrl(date, city, partySize, time);
  console.log(`  [tablecheck] FETCH ${url}`);
  const t0 = Date.now();

  const b = await getBrowser();
  const context = await b.newContext({ userAgent: UA });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-testid="Explore Venue Card"]', { timeout: 15000 }).catch(() => {});
    // Small extra wait for all cards to render
    await page.waitForTimeout(1000);

    const venues = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="Explore Venue Card"]');
      return Array.from(cards).map(card => {
        const slug = card.getAttribute('data-slug') || '';
        const nameEl = card.querySelector('[data-testid="Common Venue Card Header"]');
        const name = nameEl ? nameEl.textContent!.trim() : '';
        const img = card.querySelector('img');
        const imageUrl = img ? img.getAttribute('src') : null;
        const cuisineEl = card.querySelector('[data-testid="Common Venue Card Displayed Cuisine"]');
        const cuisine = cuisineEl ? cuisineEl.textContent!.trim() : '';
        const dp = card.querySelector('[data-testid="Common Venue Card Budget Dinner"] [data-price]');
        const lp = card.querySelector('[data-testid="Common Venue Card Budget Lunch"] [data-price]');
        const dinnerPrice = dp ? dp.getAttribute('data-price') : null;
        const lunchPrice = lp ? lp.getAttribute('data-price') : null;
        const btns = card.querySelectorAll('[data-testid="Common Venue Card Time Slot Btn"] button');
        const timeSlots = Array.from(btns).map(b => (b.textContent || '').trim()).filter(Boolean);
        return { slug, name, cuisine, dinnerPrice, lunchPrice, timeSlots, imageUrl };
      });
    });

    console.log(`  [tablecheck] page loaded in ${Date.now() - t0}ms, found ${venues.length} venues`);
    return venues;
  } finally {
    await context.close();
  }
}

/**
 * Browse TableCheck's search page to find restaurants with availability.
 * Scrapes one page per date (each page returns ~50 venues with time slots).
 */
export async function browseTableCheck(
  dateFrom: string,
  dateTo: string,
  city: string = 'tokyo',
  partySize: number = 2,
  meal?: string,
  refresh: boolean = false,
): Promise<TableCheckSearchResult> {
  const cacheKey = `${dateFrom}:${dateTo}:${city}:${partySize}:${meal || ''}`;
  if (!refresh) {
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      console.log(`  [tablecheck] CACHE HIT ${cacheKey} (${cached.data.restaurants.length} restaurants)`);
      return cached.data;
    }
  }

  const time = meal === 'lunch' ? '12:00' : '19:00';

  // Generate date range
  const dates: string[] = [];
  const start = new Date(dateFrom + 'T12:00:00');
  const end = new Date(dateTo + 'T12:00:00');
  const cur = new Date(start);
  while (cur <= end && dates.length < 14) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }

  // Scrape each date (sequentially to avoid overwhelming the browser)
  const restaurantMap = new Map<string, TableCheckRestaurant>();

  for (const date of dates) {
    const venues = await scrapeSearchPage(date, city, partySize, time);

    for (const v of venues) {
      if (!v.slug || !v.name) continue;

      const existing = restaurantMap.get(v.slug);
      if (existing) {
        if (!existing.available_dates.includes(date)) {
          existing.available_dates.push(date);
        }
        if (v.timeSlots.length > 0) {
          existing.time_slots[date] = v.timeSlots;
        }
      } else {
        // Build price range string from dinner/lunch prices
        let priceRange: string | null = null;
        if (v.dinnerPrice) {
          const dp = Math.round(parseFloat(v.dinnerPrice));
          priceRange = `¥${dp.toLocaleString()}`;
          if (v.lunchPrice) {
            const lp = Math.round(parseFloat(v.lunchPrice));
            priceRange += ` / ¥${lp.toLocaleString()} lunch`;
          }
        } else if (v.lunchPrice) {
          const lp = Math.round(parseFloat(v.lunchPrice));
          priceRange = `¥${lp.toLocaleString()} lunch`;
        }

        restaurantMap.set(v.slug, {
          name: v.name,
          tablecheck_url: `https://www.tablecheck.com/en/${v.slug}/reserve`,
          tablecheck_slug: v.slug,
          image_url: v.imageUrl,
          price_range: priceRange,
          cuisine: v.cuisine || null,
          available_dates: [date],
          time_slots: v.timeSlots.length > 0 ? { [date]: v.timeSlots } : {},
        });
      }
    }
  }

  const restaurants = [...restaurantMap.values()];
  // Sort available_dates
  for (const r of restaurants) r.available_dates.sort();

  const result: TableCheckSearchResult = { restaurants, dateFrom, dateTo };
  searchCache.set(cacheKey, { data: result, timestamp: Date.now() });
  saveCache();

  console.log(`  [tablecheck] total: ${restaurants.length} restaurants across ${dates.length} dates`);
  return result;
}
