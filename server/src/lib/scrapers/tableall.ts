import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { getBrowser, UA } from './tabelog.js';

export interface TableAllRestaurant {
  name: string;
  tableall_url: string;
  tableall_id: string;
  image_url: string | null;
  price_range: string | null;
  cuisine: string | null;
  area: string | null;
  available_dates: string[]; // YYYY-MM-DD dates with non-sold slots
}

export interface TableAllSearchResult {
  restaurants: TableAllRestaurant[];
  dateFrom: string;
  dateTo: string;
}

// File-backed cache with 4-hour TTL
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const CACHE_FILE = path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'tableall-search-cache.json',
);

type CacheEntry = { data: TableAllSearchResult; timestamp: number };
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

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Parse the TableAll search page to extract restaurants and their per-date availability
 * from the calendar section.
 *
 * Page structure:
 *   .rst-item — restaurant list cards (name, id, price, image)
 *   .slide-item — per-date calendar entries containing:
 *     .cal-head — date header (.cal-head-month, .cal-head-year, .cal-head-day)
 *     .cal-item — individual slots (restaurant name, cuisine/area, time, sold status)
 */
function parseSearchPage(
  html: string,
  dateFrom: string,
  dateTo: string,
): TableAllRestaurant[] {
  const $ = cheerio.load(html);

  // Step 1: Build restaurant metadata from the rst-item list
  const restaurantMeta = new Map<string, {
    name: string;
    price_range: string | null;
    image_url: string | null;
  }>();

  $('.rst-item').each((_i, el) => {
    const item = $(el);
    const name = item.find('.rst-name').text().trim();
    const img = item.find('img').first().attr('src') || null;
    const idMatch = img?.match(/restaurant\/(\d+)\//);
    if (!idMatch || !name) return;

    const id = idMatch[1];
    if (restaurantMeta.has(id)) return;

    let priceRange: string | null = null;
    const iconsText = item.find('.rst-info-icons').text();
    const priceMatch = iconsText.match(/￥[\d,]+/);
    if (priceMatch) priceRange = priceMatch[0] + ' ~';

    restaurantMeta.set(id, { name, price_range: priceRange, image_url: img });
  });

  // Step 2: Parse the calendar to get per-date, per-restaurant availability
  // Each .slide-item has a .cal-head (date) and .cal-item entries (restaurant slots)
  const restaurantDates = new Map<string, Set<string>>(); // id -> set of YYYY-MM-DD
  const restaurantInfo = new Map<string, { cuisine: string | null; area: string | null }>(); // id -> cuisine/area from cal

  $('div.slide-item').each((_i, el) => {
    const slide = $(el);
    const monthText = slide.find('.cal-head-month').text().trim();
    const yearText = slide.find('.cal-head-year').text().trim();
    const dayText = slide.find('.cal-head-day').text().trim();

    if (!monthText || !yearText || !dayText) return;

    const month = parseInt(monthText, 10);
    const year = parseInt(yearText, 10);
    const day = parseInt(dayText, 10);
    if (isNaN(month) || isNaN(year) || isNaN(day)) return;

    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // Skip dates outside requested range
    if (dateStr < dateFrom || dateStr > dateTo) return;

    // Parse each cal-item in this date
    slide.find('.cal-item').each((_j, itemEl) => {
      const item = $(itemEl);
      // Skip sold-out slots
      if (item.hasClass('sold')) return;

      const img = item.find('img').first().attr('src') || '';
      const idMatch = img.match(/restaurant\/(\d+)\//);
      if (!idMatch) return;

      const id = idMatch[1];

      // Track that this restaurant is available on this date
      if (!restaurantDates.has(id)) restaurantDates.set(id, new Set());
      restaurantDates.get(id)!.add(dateStr);

      // Extract cuisine/area from cal-item-genre (format: "Sushi, Ginza")
      if (!restaurantInfo.has(id)) {
        const genre = item.find('.cal-item-genre').text().trim();
        const parts = genre.split(',').map(s => s.trim());
        restaurantInfo.set(id, {
          cuisine: parts[0] || null,
          area: parts[1] || null,
        });
      }
    });
  });

  // Step 3: Build the final restaurant list, merging metadata + calendar dates
  const restaurants: TableAllRestaurant[] = [];
  for (const [id, dates] of restaurantDates) {
    const meta = restaurantMeta.get(id);
    const info = restaurantInfo.get(id);
    const name = meta?.name || info?.cuisine || `Restaurant ${id}`;

    restaurants.push({
      name,
      tableall_url: `https://www.tableall.com/restaurant/${id}`,
      tableall_id: id,
      image_url: meta?.image_url || `https://d267qvt8mf7rfa.cloudfront.net/restaurant/${id}/searchResultImage-thumb300x200.jpg`,
      price_range: meta?.price_range || null,
      cuisine: info?.cuisine || null,
      area: info?.area || null,
      available_dates: [...dates].sort(),
    });
  }

  return restaurants;
}

/**
 * Browse TableAll's date search page to find restaurants with availability.
 * The search page contains both a restaurant list and a per-date calendar,
 * so we can extract everything from a single page load.
 */
export async function browseTableAll(
  dateFrom: string,
  dateTo: string,
  area?: string,
  refresh: boolean = false,
): Promise<TableAllSearchResult> {
  const cacheKey = `${dateFrom}:${dateTo}:${area || ''}`;
  if (!refresh) {
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      console.log(`  [tableall] CACHE HIT ${cacheKey} (${cached.data.restaurants.length} restaurants)`);
      return cached.data;
    }
  }

  const params = new URLSearchParams({ from: dateFrom, to: dateTo });
  if (area) params.set('area', area);
  const url = `https://www.tableall.com/opening/index?${params.toString()}`;

  console.log(`  [tableall] FETCH ${url}`);
  const t0 = Date.now();

  // Use Playwright to render the search page (calendar is JS-rendered)
  const b = await getBrowser();
  const context = await b.newContext({ userAgent: UA });
  const page = await context.newPage();

  let restaurants: TableAllRestaurant[];
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for calendar content to render
    await page.waitForSelector('.cal-item', { timeout: 10000 }).catch(() => {});
    const html = await page.content();
    restaurants = parseSearchPage(html, dateFrom, dateTo);
    console.log(`  [tableall] page loaded in ${Date.now() - t0}ms, found ${restaurants.length} restaurants with available dates`);
  } finally {
    await context.close();
  }

  const result: TableAllSearchResult = { restaurants, dateFrom, dateTo };
  searchCache.set(cacheKey, { data: result, timestamp: Date.now() });
  saveCache();
  return result;
}
