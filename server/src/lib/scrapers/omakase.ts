import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { getBrowser, UA } from './tabelog.js';
import db from '../db.js';

// --- Types ---

export interface OmakaseRestaurant {
  name: string;
  omakase_url: string;
  omakase_id: string;
  image_url: string | null;
  cuisine: string | null;
  area: string | null;
  available_dates: string[]; // YYYY-MM-DD dates with at least one available meal
  available_meals: Record<string, ('lunch' | 'dinner')[]>; // date -> available meal types
}

export interface OmakaseSearchResult {
  restaurants: OmakaseRestaurant[];
  dateFrom: string;
  dateTo: string;
}

// --- Area ID mapping ---

export const AREA_IDS: Record<string, number> = {
  tokyo: 171,
  ginza: 172,
  nihonbashi: 175,
  kanto: 176,
  kyushu: 178,
  shikoku: 179,
  chugoku: 180,
  hokuriku: 181,
  tokai: 182,
  osaka: 183,
  kyoto: 184,
  tohoku: 185,
  shimbashi: 187,
  roppongi: 188,
  toranomon: 189,
  shirokane: 190,
  shibuya: 191,
  ueno: 192,
  shinagawa: 193,
  shinjuku: 194,
  meguro: 195,
  sendagaya: 196,
  asagaya: 197,
  hokkaido: 174,
  kansai: 177,
};

// --- File-backed cache ---

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const CACHE_FILE = path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'omakase-search-cache.json',
);

type CacheEntry = { data: OmakaseSearchResult; timestamp: number };
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

// --- Rate limiting ---

function randomDelay(minMs = 1500, maxMs = 3000): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Month name to number (for parsing date headers like "Feb 19") ---

const MONTH_ABBREVS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// --- Session management ---

interface OmakaseAccount {
  id: string;
  email: string;
  password_enc: string;
  cookie_data: string | null;
  last_login_at: string | null;
}

function getAccount(): OmakaseAccount | null {
  return db.prepare(
    "SELECT id, email, password_enc, cookie_data, last_login_at FROM booking_accounts WHERE platform = 'omakase' AND is_valid = 1 ORDER BY updated_at DESC LIMIT 1"
  ).get() as OmakaseAccount | null;
}

/**
 * Get an authenticated Playwright browser context for omakase.in.
 * Restores saved cookies if fresh, otherwise performs login.
 * Caller MUST close the returned context when done.
 */
export async function getOmakaseSession(): Promise<{ context: BrowserContext; page: Page }> {
  const account = getAccount();
  if (!account) {
    throw new Error('No valid omakase account configured. Add one at /accounts with platform "omakase".');
  }

  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  // Try restoring saved cookies if they're fresh (< 24h)
  const cookiesFresh = account.cookie_data && account.last_login_at &&
    (Date.now() - new Date(account.last_login_at).getTime()) < 24 * 60 * 60 * 1000;

  if (cookiesFresh && account.cookie_data) {
    try {
      const cookies = JSON.parse(account.cookie_data);
      await context.addCookies(cookies);
      console.log('  [omakase] restored saved cookies (skipping verification — will check on first navigation)');
      return { context, page };
    } catch (err) {
      console.log('  [omakase] cookie restore failed, will re-login:', err);
    }
  }

  // Login flow
  console.log(`  [omakase] logging in as ${account.email}`);
  await page.goto('https://omakase.in/users/sign_in?locale=en', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for Cloudflare challenge to resolve (Playwright handles JS challenges)
  await page.waitForSelector('input[name="user[email]"], input[type="email"]', { timeout: 15000 });

  await page.fill('input[name="user[email]"], input[type="email"]', account.email);
  await page.fill('input[name="user[password]"], input[type="password"]', account.password_enc);
  await page.click('input[type="submit"], button[type="submit"]');

  // Wait for redirect after login
  await page.waitForURL(url => !url.toString().includes('sign_in'), { timeout: 15000 });
  console.log(`  [omakase] login successful — redirected to ${page.url()}`);

  // Save cookies
  const cookies = await context.cookies();
  const cookieJson = JSON.stringify(cookies);
  db.prepare(
    "UPDATE booking_accounts SET cookie_data = ?, last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(cookieJson, account.id);
  console.log(`  [omakase] saved ${cookies.length} cookies`);

  return { context, page };
}

// --- HTML parser ---

/**
 * Parse the omakase.in Premium search results page.
 *
 * Page structure:
 *   div.c-rItem_advanced — restaurant card
 *     a[href*="/en/r/"] — link with omakase ID
 *     h4.ui.header — name
 *     .c-rItem_advanced_detail > span — "Cuisine / Area"
 *     .c-rItem_advanced_img div[style] — background-image URL
 *     .c-restaurant_item_date table — availability grid
 *       tr[0] th — date headers (e.g. "Feb 19\nThu")
 *       tr[1] — lunch (fa-sun), tr[2] — dinner (fa-moon)
 *       td with .c-rItem_advanced_avlbl = available, otherwise unavailable
 */
export function parseSearchPage(html: string, year: number): OmakaseRestaurant[] {
  const $ = cheerio.load(html);
  const restaurants: OmakaseRestaurant[] = [];

  $('div.c-rItem_advanced').each((_i, el) => {
    const card = $(el);

    // Extract omakase URL and ID
    const link = card.find('a[href*="/en/r/"]').first().attr('href');
    if (!link) return;
    const idMatch = link.match(/\/en\/r\/([a-z0-9]+)/);
    if (!idMatch) return;
    const omakaseId = idMatch[1];
    const omakaseUrl = link.startsWith('http') ? link : `https://omakase.in${link}`;

    // Name
    const name = card.find('h4.ui.header').first().text().trim();
    if (!name) return;

    // Cuisine / Area from span inside detail
    const detailSpan = card.find('.c-rItem_advanced_detail > span').first().text().trim();
    const [cuisine, area] = detailSpan.split('/').map(s => s.trim());

    // Image from background-image style
    let imageUrl: string | null = null;
    const imgDiv = card.find('.c-rItem_advanced_img div[style]').first();
    const styleAttr = imgDiv.attr('style') || '';
    const bgMatch = styleAttr.match(/url\(([^)]+)\)/);
    if (bgMatch) imageUrl = bgMatch[1].replace(/['"]/g, '');

    // Parse availability table
    const table = card.find('.c-restaurant_item_date table');
    if (!table.length) return;

    // Parse date headers from first row
    const dateColumns: string[] = [];
    let currentYear = year;
    let prevMonth = 0;
    table.find('tr').first().find('th').each((_j, th) => {
      const text = $(th).text().trim();
      // Format: "Feb 19\nThu" — extract month + day
      const dateMatch = text.match(/([A-Za-z]+)\s+(\d+)/);
      if (dateMatch) {
        const monthNum = MONTH_ABBREVS[dateMatch[1].toLowerCase().slice(0, 3)];
        const day = parseInt(dateMatch[2], 10);
        if (monthNum && !isNaN(day)) {
          // Detect year rollover (e.g. Dec -> Jan)
          if (prevMonth > 0 && monthNum < prevMonth) currentYear++;
          prevMonth = monthNum;
          dateColumns.push(`${currentYear}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        }
      }
    });

    if (dateColumns.length === 0) return;

    // Parse meal rows
    const rows = table.find('tr').toArray().slice(1); // skip header row
    const availableMeals: Record<string, ('lunch' | 'dinner')[]> = {};

    for (const row of rows) {
      const $row = $(row);
      const cells = $row.find('td').toArray();
      if (cells.length === 0) continue;

      // First cell has the meal icon
      const firstCell = $(cells[0]);
      const isLunch = firstCell.find('.fa-sun').length > 0;
      const isDinner = firstCell.find('.fa-moon').length > 0;
      const mealType: 'lunch' | 'dinner' | null = isLunch ? 'lunch' : isDinner ? 'dinner' : null;
      if (!mealType) continue;

      // Remaining cells correspond to date columns
      const dateCells = cells.slice(1);
      for (let k = 0; k < dateCells.length && k < dateColumns.length; k++) {
        const cell = $(dateCells[k]);
        const isAvailable = cell.find('.c-rItem_advanced_avlbl').length > 0;
        if (isAvailable) {
          const dateStr = dateColumns[k];
          if (!availableMeals[dateStr]) availableMeals[dateStr] = [];
          availableMeals[dateStr].push(mealType);
        }
      }
    }

    const availableDates = Object.keys(availableMeals).sort();

    restaurants.push({
      name,
      omakase_url: omakaseUrl,
      omakase_id: omakaseId,
      image_url: imageUrl,
      cuisine: cuisine || null,
      area: area || null,
      available_dates: availableDates,
      available_meals: availableMeals,
    });
  });

  return restaurants;
}

// --- Discovery scraper ---

const MAX_PAGES = 5;

/**
 * Browse omakase.in Premium search to find restaurants with availability.
 * Paginates through results, parsing server-rendered HTML with Cheerio.
 *
 * @param onPage — optional callback fired after each page is parsed, enabling
 *   the caller to stream partial results to the client immediately.
 */
export async function browseOmakase(
  dateFrom: string,
  dateTo: string,
  areaId?: number,
  guestsCount: number = 2,
  refresh: boolean = false,
  onPage?: (restaurants: OmakaseRestaurant[], pageNum: number, hasMore: boolean) => void,
): Promise<OmakaseSearchResult> {
  const effectiveAreaId = areaId || 171; // default Tokyo
  const cacheKey = `${dateFrom}:${dateTo}:${effectiveAreaId}:${guestsCount}`;

  if (!refresh) {
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      console.log(`  [omakase] CACHE HIT ${cacheKey} (${cached.data.restaurants.length} restaurants)`);
      // Emit all cached restaurants in one shot
      onPage?.(cached.data.restaurants, 1, false);
      return cached.data;
    }
  }

  // Determine year from dateFrom for parsing month/day headers
  const year = parseInt(dateFrom.slice(0, 4), 10);

  const t0 = Date.now();
  const { context, page } = await getOmakaseSession();

  const allRestaurants: OmakaseRestaurant[] = [];
  const seenIds = new Set<string>();

  try {
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const params = new URLSearchParams({
        area_id: String(effectiveAreaId),
        from_date: dateFrom,
        to_date: dateTo,
        guests_count: String(guestsCount),
        keyword: '',
      });
      if (pageNum > 1) params.set('page', String(pageNum));

      const url = `https://omakase.in/users/premium/restaurants?${params.toString()}`;
      console.log(`  [omakase] FETCH page ${pageNum}: ${url}`);

      if (pageNum > 1) await randomDelay();

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // On first page, check if cookies were stale (redirected to login)
      if (pageNum === 1 && page.url().includes('sign_in')) {
        console.log('  [omakase] cookies stale — redirected to login, re-authenticating...');
        const account = getAccount();
        if (!account) throw new Error('No valid omakase account');
        await page.waitForSelector('input[name="user[email]"], input[type="email"]', { timeout: 15000 });
        await page.fill('input[name="user[email]"], input[type="email"]', account.email);
        await page.fill('input[name="user[password]"], input[type="password"]', account.password_enc);
        await page.click('input[type="submit"], button[type="submit"]');
        await page.waitForURL(u => !u.toString().includes('sign_in'), { timeout: 15000 });
        console.log(`  [omakase] re-login successful`);
        // Save new cookies
        const newCookies = await context.cookies();
        db.prepare(
          "UPDATE booking_accounts SET cookie_data = ?, last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify(newCookies), account.id);
        // Re-navigate to search URL
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // Wait for restaurant cards to render
      await page.waitForSelector('.c-rItem_advanced', { timeout: 10000 }).catch(() => {});

      const html = await page.content();
      const pageRestaurants = parseSearchPage(html, year);

      // Deduplicate
      const newRestaurants: OmakaseRestaurant[] = [];
      for (const r of pageRestaurants) {
        if (!seenIds.has(r.omakase_id)) {
          seenIds.add(r.omakase_id);
          allRestaurants.push(r);
          newRestaurants.push(r);
        }
      }

      // Check if there's a next page
      const $ = cheerio.load(html);
      const hasNextPage = $('div.ui.pagination.menu a.item').toArray().some(a => {
        const href = $(a).attr('href') || '';
        return href.includes(`page=${pageNum + 1}`);
      });

      console.log(`  [omakase] page ${pageNum}: ${pageRestaurants.length} restaurants (${allRestaurants.length} total)${hasNextPage ? '' : ' [LAST]'}`);

      // Notify caller immediately so they can stream to client
      onPage?.(newRestaurants, pageNum, hasNextPage);

      if (!hasNextPage) break;
    }

    console.log(`  [omakase] done in ${Date.now() - t0}ms — ${allRestaurants.length} restaurants total`);
  } finally {
    await context.close();
  }

  const result: OmakaseSearchResult = { restaurants: allRestaurants, dateFrom, dateTo };
  searchCache.set(cacheKey, { data: result, timestamp: Date.now() });
  saveCache();
  return result;
}
