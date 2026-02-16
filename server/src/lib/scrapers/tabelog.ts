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
 * Fuzzy word matching for restaurant names.
 * Allows prefix match if the shorter word is ≥70% of the longer (e.g., "saito"/"saitou").
 */
function wordMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    if (shorter / longer >= 0.7 && (a.startsWith(b) || b.startsWith(a))) return true;
  }
  return false;
}

/**
 * Normalize a restaurant name for matching: lowercase, strip diacritics, keep alphanumeric + spaces.
 */
function normalizeName(s: string): string {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Persistent cache for Serper-resolved Tabelog scores (avoids re-searching)
const SCORE_CACHE_FILE = path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'tabelog-score-cache.json',
);
type ScoreCacheEntry = { tabelog_url: string | null; tabelog_score: number | null; timestamp: number };
let scoreCache = new Map<string, ScoreCacheEntry>();
const SCORE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function loadScoreCache() {
  try {
    if (fs.existsSync(SCORE_CACHE_FILE)) {
      scoreCache = new Map(Object.entries(JSON.parse(fs.readFileSync(SCORE_CACHE_FILE, 'utf-8'))));
    }
  } catch { /* ignore */ }
}
function saveScoreCache() {
  try {
    const dir = path.dirname(SCORE_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SCORE_CACHE_FILE, JSON.stringify(Object.fromEntries(scoreCache)));
  } catch { /* non-critical */ }
}
loadScoreCache();

/**
 * Search Google via Serper to find a restaurant's Tabelog URL, then scrape the score.
 * Searches all tabelog.com (any language) and normalizes to the English URL.
 */
async function serperLookupScore(
  name: string,
  city: string,
): Promise<{ tabelog_url: string | null; tabelog_score: number | null }> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey || apiKey === 'your-serper-api-key-here') return { tabelog_url: null, tabelog_score: null };

  const citySlug = TABELOG_CITIES[city.toLowerCase()] || city.toLowerCase();
  const urlPattern = /(?:s\.)?tabelog\.com\/(?:[a-z]{2}\/)?([^/]+)\/A(\d+)\/A(\d+)\/(\d+)\//;

  // Try full name first, then fall back to last word (the distinctive part) if no match
  const queries = [`site:tabelog.com ${name} ${citySlug}`];
  const words = name.split(/\s+/);
  if (words.length >= 2) {
    queries.push(`site:tabelog.com ${words[words.length - 1]} ${citySlug}`);
  }

  let tabelogResult: { link: string } | undefined;
  for (const query of queries) {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) continue;
    const data = await res.json() as { organic?: { link: string; title: string }[] };
    tabelogResult = data.organic?.find(r => urlPattern.test(r.link));
    if (tabelogResult) break;
  }
  if (!tabelogResult) return { tabelog_url: null, tabelog_score: null };

  const match = tabelogResult.link.match(urlPattern);
  if (!match) return { tabelog_url: null, tabelog_score: null };

  // Construct the canonical English URL
  const [, prefecture, area1, area2, restaurantId] = match;
  const enUrl = `https://tabelog.com/en/${prefecture}/A${area1}/A${area2}/${restaurantId}/`;

  // Fast-fetch the Tabelog page to get the score
  try {
    const pageRes = await fetch(enUrl, { headers: { 'User-Agent': UA } });
    const html = await pageRes.text();
    const $ = cheerio.load(html);
    const scoreText = $('.rdheader-rating__score-val-dtl, .c-rating__val').first().text().trim();
    const score = scoreText ? parseFloat(scoreText) : null;
    const validScore = score && !isNaN(score) && score > 0 && score <= 5 ? score : null;
    return { tabelog_url: enUrl, tabelog_score: validScore };
  } catch {
    return { tabelog_url: enUrl, tabelog_score: null };
  }
}

/**
 * Look up Tabelog scores for restaurant names.
 * 1. Check browse cache with fuzzy matching (no network)
 * 2. Check persistent score cache (previously resolved via Serper)
 * 3. Search Google via Serper for remaining, then scrape the Tabelog page for score
 */
export async function lookupScoresByName(
  names: string[],
  city: string = 'tokyo',
): Promise<Map<string, { tabelog_url: string | null; tabelog_score: number | null }>> {
  const result = new Map<string, { tabelog_url: string | null; tabelog_score: number | null }>();

  // Build normalized index from browse cache
  const normalizedIndex = new Map<string, { name: string; tabelog_url: string | null; tabelog_score: number | null }>();
  for (const entry of browseCache.values()) {
    for (const r of entry.data.restaurants) {
      if (r.name && r.tabelog_score) {
        const norm = normalizeName(r.name);
        if (!normalizedIndex.has(norm)) {
          normalizedIndex.set(norm, { name: r.name, tabelog_url: r.tabelog_url, tabelog_score: r.tabelog_score });
        }
      }
    }
  }

  const remaining: string[] = [];

  for (const name of names) {
    const qNorm = normalizeName(name);

    // Step 1a. Exact normalized match from browse cache
    const exact = normalizedIndex.get(qNorm);
    if (exact) {
      result.set(name, { tabelog_url: exact.tabelog_url, tabelog_score: exact.tabelog_score });
      continue;
    }

    // Step 1b. Fuzzy: all query words must match some candidate word, or vice versa
    const qWords = qNorm.split(' ');
    let bestMatch: { name: string; tabelog_url: string | null; tabelog_score: number | null } | null = null;
    let bestShared = 0;
    for (const [norm, data] of normalizedIndex) {
      const cWords = norm.split(' ');
      const allQueryMatch = qWords.every(qw => cWords.some(cw => wordMatch(qw, cw)));
      const allCandMatch = cWords.every(cw => qWords.some(qw => wordMatch(qw, cw)));
      if (allQueryMatch || allCandMatch) {
        const shared = qWords.filter(qw => cWords.some(cw => wordMatch(qw, cw))).length;
        if (shared > bestShared) {
          bestShared = shared;
          bestMatch = data;
        }
      }
    }
    if (bestMatch) {
      result.set(name, { tabelog_url: bestMatch.tabelog_url, tabelog_score: bestMatch.tabelog_score });
      continue;
    }

    // Step 2. Check persistent score cache
    const cached = scoreCache.get(name);
    if (cached && Date.now() - cached.timestamp < SCORE_CACHE_TTL) {
      result.set(name, { tabelog_url: cached.tabelog_url, tabelog_score: cached.tabelog_score });
      continue;
    }

    remaining.push(name);
  }

  const cacheMatched = Array.from(result.values()).filter(v => v.tabelog_score).length;
  if (names.length > 0) {
    console.log(`  [tabelog-score] cache: ${cacheMatched}/${names.length}, searching ${remaining.length} via Serper...`);
  }

  // Step 3. Serper lookup for remaining names (parallel with concurrency limit)
  if (remaining.length > 0) {
    const CONCURRENCY = 5;
    for (let i = 0; i < remaining.length; i += CONCURRENCY) {
      const batch = remaining.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (name) => {
        try {
          const data = await serperLookupScore(name, city);
          result.set(name, data);
          scoreCache.set(name, { ...data, timestamp: Date.now() });
          if (data.tabelog_score) {
            console.log(`  [tabelog-score]   ${name} -> ${data.tabelog_score} (${data.tabelog_url?.slice(0, 60)})`);
          }
        } catch {
          // Non-critical
        }
      }));
    }
    saveScoreCache();
  }

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
