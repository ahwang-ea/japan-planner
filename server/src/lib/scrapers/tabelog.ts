import { chromium, type Browser, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    });
  }
  return browser;
}

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface TabelogData {
  name: string | null;
  name_ja: string | null;
  tabelog_url: string | null;
  tabelog_score: number | null;
  cuisine: string | null;
  area: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  price_range: string | null;
  hours: string | null;
  image_url: string | null;
  has_online_reservation?: boolean;
  reservation_url?: string | null;
  time_slots?: string[];
}

export interface TabelogListResult {
  restaurants: TabelogData[];
  page: number;
  hasNextPage: boolean;
  dateFiltered?: boolean;   // true when results are pre-filtered by Tabelog for date availability
  filteredDate?: string;    // YYYY-MM-DD date used for filtering
}

export const TABELOG_CITIES: Record<string, string> = {
  tokyo: 'tokyo',
  osaka: 'osaka',
  kyoto: 'kyoto',
  fukuoka: 'fukuoka',
  sapporo: 'hokkaido',
  nagoya: 'aichi',
  yokohama: 'kanagawa',
  kobe: 'hyogo',
  hiroshima: 'hiroshima',
  sendai: 'miyagi',
  nara: 'nara',
  kanazawa: 'ishikawa',
};

// File-backed cache persists across server restarts
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_FILE = path.join(process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data', 'tabelog-cache.json');

type CacheEntry = { data: TabelogListResult; timestamp: number };
let browseCache = new Map<string, CacheEntry>();

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, CacheEntry>;
      browseCache = new Map(Object.entries(raw));
    }
  } catch { /* ignore corrupt cache */ }
}

function saveCacheToDisk() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(browseCache)));
  } catch { /* non-critical */ }
}

// Load on module init
loadCacheFromDisk();

/**
 * Parse restaurant list HTML with cheerio (fast, no browser needed).
 * Shared by both fast fetch path and Playwright fallback.
 */
function parseListHtml(
  html: string,
  city: string,
  dateFilter?: { date?: string; time?: string; partySize?: number },
): { restaurants: Map<string, TabelogData>; hasNextPage: boolean } {
  const $ = cheerio.load(html);
  const seenUrls = new Map<string, TabelogData>();

  $('.list-rst').each((_i, el) => {
    const item = $(el);

    // Name & URL
    const nameEl = item.find('.list-rst__rst-name-target').first();
    const name = nameEl.text().trim() || null;
    const tabelogUrl = nameEl.attr('href') || null;
    if (!name) return; // continue

    // Score
    let score: number | null = null;
    const scoreText = item.find('.c-rating__val, .list-rst__rating-val').first().text().trim();
    if (scoreText) {
      const parsed = parseFloat(scoreText);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 5) score = parsed;
    }

    // Area & Cuisine
    let area: string | null = null;
    let cuisine: string | null = null;
    const areaGenreText = item.find('.list-rst__area-genre').first().text().trim();
    if (areaGenreText) {
      const parts = areaGenreText.split('/');
      area = parts[0]?.trim() || null;
      cuisine = parts[1]?.trim() || null;
    }

    // Price range (v3 rating layout: dinner / lunch price spans)
    const prices: string[] = [];
    item.find('.list-rst__budget').each((_j, budgetEl) => {
      const t = $(budgetEl).text().trim();
      if (t) prices.push(t);
    });
    if (prices.length === 0) {
      // Fallback: c-rating-v3 layout used on ranked list pages
      item.find('.c-rating-v3.list-rst__info-item').each((_j, ratingEl) => {
        const val = $(ratingEl).find('.c-rating-v3__val').text().trim();
        if (val && val !== '-') {
          const isDinner = $(ratingEl).find('.c-rating-v3__time--dinner').length > 0;
          const isLunch = $(ratingEl).find('.c-rating-v3__time--lunch').length > 0;
          const label = isDinner ? 'Dinner' : isLunch ? 'Lunch' : '';
          prices.push(label ? `${label}: ${val}` : val);
        }
      });
    }
    const priceRange = prices.join(' / ') || null;

    // Image thumbnail
    let imageUrl: string | null = null;
    // Check div.js-cassette-img for data-original (background image pattern)
    const bgDiv = item.find('div.js-cassette-img[data-original]').first();
    if (bgDiv.length > 0) {
      const val = bgDiv.attr('data-original');
      if (val && val.startsWith('http') && !val.includes('no_image')) imageUrl = val;
    }
    // Fallback: check img elements with various lazy-load attributes
    if (!imageUrl) {
      for (const imgSel of ['.list-rst__rst-photo img', '.list-rst__photo img', '.list-rst__img img', 'img.js-cassette-img']) {
        const imgEl = item.find(imgSel).first();
        if (imgEl.length === 0) continue;
        for (const attr of ['data-lazy', 'data-original', 'data-src', 'src']) {
          const val = imgEl.attr(attr);
          if (val && val.startsWith('http') && !val.includes('no_image')) {
            imageUrl = val;
            break;
          }
        }
        if (imageUrl) break;
      }
    }

    // Inline reservation availability
    let hasOnlineReservation = false;
    let reservationUrl: string | null = null;
    const yoyakuLink = item.find('a[href*="yoyaku.tabelog.com"]').first();
    if (yoyakuLink.length > 0) {
      hasOnlineReservation = true;
      reservationUrl = yoyakuLink.attr('href') || null;
    }
    if (!hasOnlineReservation) {
      const itemHtml = item.html() || '';
      if (/Online Booking|ネット予約/i.test(itemHtml)) hasOnlineReservation = true;
    }

    // Time slots from booking links (date-filtered pages)
    const timeSlots: string[] = [];
    if (dateFilter?.date) {
      item.find('a[href*="booking/form_course"]').each((_j, linkEl) => {
        const href = $(linkEl).attr('href');
        const timeMatch = href?.match(/visit_time=(\d{4})/);
        if (timeMatch) {
          const t = timeMatch[1];
          const formatted = `${t.slice(0, 2)}:${t.slice(2, 4)}`;
          if (!timeSlots.includes(formatted)) timeSlots.push(formatted);
        }
      });
    }

    const entry: TabelogData = {
      name, name_ja: null, tabelog_url: tabelogUrl, tabelog_score: score,
      cuisine, area, city, address: null, phone: null,
      price_range: priceRange, hours: null, image_url: imageUrl,
      has_online_reservation: dateFilter?.date ? true : hasOnlineReservation,
      reservation_url: reservationUrl,
      time_slots: timeSlots.length > 0 ? timeSlots : undefined,
    };

    // Dedup: keep the entry with the best data
    const key = tabelogUrl || name;
    const existing = seenUrls.get(key);
    if (!existing) {
      seenUrls.set(key, entry);
    } else {
      const quality = (e: TabelogData) =>
        (e.tabelog_score ? 10 : 0) + (e.cuisine ? 1 : 0) +
        (e.area ? 1 : 0) + (e.price_range ? 1 : 0);
      if (quality(entry) > quality(existing)) {
        seenUrls.set(key, entry);
      }
    }
  });

  const hasNextPage = $('a.c-pagination__arrow--next').length > 0;
  return { restaurants: seenUrls, hasNextPage };
}

function buildBrowseUrl(citySlug: string, page: number, sort: string, dateFilter?: { date?: string; time?: string; partySize?: number }): string {
  const params = new URLSearchParams();
  if (sort === 'rt') params.set('SrtT', 'rt');
  if (dateFilter?.date) {
    params.set('svd', dateFilter.date.replace(/-/g, ''));
    params.set('vac_net', '1');
  }
  if (dateFilter?.time) params.set('svt', dateFilter.time);
  if (dateFilter?.partySize) params.set('svps', String(dateFilter.partySize));
  const queryStr = params.toString() ? `?${params.toString()}` : '';
  return page === 1
    ? `https://tabelog.com/en/${citySlug}/rstLst/${queryStr}`
    : `https://tabelog.com/en/${citySlug}/rstLst/${page}/${queryStr}`;
}

/**
 * Browse Tabelog ranking page for a city, sorted by score.
 * Uses fast HTTP fetch + cheerio for standard browsing.
 * Falls back to Playwright for date-filtered pages (booking time slots may need JS).
 */
export async function browseTabelog(
  city: string,
  page: number = 1,
  refresh: boolean = false,
  sort: string = 'rt',
  dateFilter?: { date?: string; time?: string; partySize?: number },
): Promise<TabelogListResult> {
  const dateFilterKey = dateFilter?.date ? `:${dateFilter.date}:${dateFilter.time || ''}:${dateFilter.partySize || ''}` : '';
  const cacheKey = `${city.toLowerCase()}:${page}:${sort}${dateFilterKey}`;
  if (!refresh) {
    const cached = browseCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      console.log(`  [browse] CACHE HIT key=${cacheKey} (${cached.data.restaurants.length} restaurants)`);
      return cached.data;
    }
  }

  const citySlug = TABELOG_CITIES[city.toLowerCase()] || city.toLowerCase();
  const url = buildBrowseUrl(citySlug, page, sort, dateFilter);
  const hasDateFilter = !!dateFilter?.date;

  console.log(`  [browse] FETCH ${url}${hasDateFilter ? '' : ' (fast)'}`);

  let html: string;
  if (hasDateFilter) {
    // Date-filtered pages may have JS-rendered booking slots — use Playwright
    const b = await getBrowser();
    const context = await b.newContext({ userAgent: UA });
    const pageObj = await context.newPage();
    try {
      await pageObj.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await pageObj.locator('.list-rst').first().waitFor({ timeout: 5000 }).catch(() => {});
      html = await pageObj.content();
    } finally {
      await context.close();
    }
  } else {
    // Standard browse: fast HTTP fetch (page is server-rendered)
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    html = await res.text();
  }

  const { restaurants: seenUrls, hasNextPage } = parseListHtml(html, city, dateFilter);

  const bookableCount = Array.from(seenUrls.values()).filter(r => r.has_online_reservation).length;
  console.log(`  [browse] ${citySlug} p${page} sort=${sort}${hasDateFilter ? ` date=${dateFilter.date} vac_net=1` : ''}: ${seenUrls.size} restaurants, ${bookableCount} bookable online`);

  const normalizedDate = hasDateFilter && dateFilter.date
    ? (dateFilter.date.length === 8
      ? `${dateFilter.date.slice(0,4)}-${dateFilter.date.slice(4,6)}-${dateFilter.date.slice(6,8)}`
      : dateFilter.date)
    : undefined;
  const result: TabelogListResult = {
    restaurants: Array.from(seenUrls.values()),
    page,
    hasNextPage,
    dateFiltered: hasDateFilter || undefined,
    filteredDate: normalizedDate,
  };

  browseCache.set(cacheKey, { data: result, timestamp: Date.now() });
  saveCacheToDisk();
  return result;
}

/**
 * Scrape a single Tabelog restaurant page for full details.
 * Uses locators + innerHTML parsing to avoid evaluate issues.
 */
export async function scrapeTabelog(url: string): Promise<TabelogData> {
  const b = await getBrowser();
  const context = await b.newContext({ userAgent: UA });
  const pageObj = await context.newPage();

  try {
    await pageObj.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageObj.waitForTimeout(2000);

    // Try JSON-LD for structured data
    let structured: Record<string, unknown> | null = null;
    try {
      const jsonLdText = await pageObj.locator('script[type="application/ld+json"]').first().textContent({ timeout: 1000 });
      if (jsonLdText) {
        const parsed = JSON.parse(jsonLdText);
        structured = Array.isArray(parsed) ? parsed.find((p: Record<string, unknown>) => p['@type'] === 'Restaurant') : parsed;
      }
    } catch { /* no json-ld */ }

    // Score
    let score: number | null = null;
    for (const sel of ['.rdheader-rating__score-val-dtl', '.rdheader-rating__score-val', '.c-rating__val']) {
      try {
        const text = (await pageObj.locator(sel).first().textContent({ timeout: 500 }))?.trim();
        if (text) {
          const parsed = parseFloat(text);
          if (!isNaN(parsed) && parsed > 0 && parsed <= 5) { score = parsed; break; }
        }
      } catch { continue; }
    }

    // Name
    let name: string | null = structured?.name ? String(structured.name) : null;
    let nameJa: string | null = null;
    try {
      const heading = (await pageObj.locator('.rdheader-rstname').first().textContent({ timeout: 500 }))?.trim();
      if (heading) {
        if (!name) name = heading;
        else if (heading !== name) nameJa = heading;
      }
    } catch { /* skip */ }
    if (!name) name = (await pageObj.title()).split(/[–\-|]/)[0]?.trim() || null;

    // Address from structured data
    let address: string | null = null;
    if (structured?.address) {
      const addr = structured.address as Record<string, string>;
      address = addr.streetAddress || [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ') || null;
    }

    // Phone from structured data
    let phone: string | null = structured?.telephone ? String(structured.telephone) : null;

    // Cuisine
    let cuisine: string | null = structured?.servesCuisine ? String(structured.servesCuisine) : null;

    // Price
    let priceRange: string | null = structured?.priceRange ? String(structured.priceRange) : null;

    // Area from breadcrumbs
    let area: string | null = null;
    let city: string | null = null;
    if (structured?.address) {
      city = (structured.address as Record<string, string>).addressLocality || null;
    }

    // Image
    let imageUrl: string | null = null;
    if (structured?.image) {
      const img = structured.image;
      if (typeof img === 'string') {
        imageUrl = img;
      } else if (Array.isArray(img) && img.length > 0) {
        const first = img[0];
        imageUrl = typeof first === 'string' ? first : (first as Record<string, string>)?.url || null;
      } else if (typeof img === 'object' && img !== null) {
        imageUrl = (img as Record<string, string>).url || null;
      }
    }
    if (!imageUrl) {
      for (const imgSel of ['.rstdtl-top-photo img', '.rdheader-photo img', '.js-imagebox-main img', '.rstdtl-photo img']) {
        try {
          const src = await pageObj.locator(imgSel).first().getAttribute('src', { timeout: 300 });
          if (src && src.startsWith('http') && !src.includes('no_image')) {
            imageUrl = src;
            break;
          }
        } catch { continue; }
      }
    }

    return {
      name, name_ja: nameJa, tabelog_url: url,
      tabelog_score: score, cuisine, area, city, address, phone,
      price_range: priceRange, hours: null, image_url: imageUrl,
    };
  } finally {
    await context.close();
  }
}
