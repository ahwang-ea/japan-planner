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

// ── Platform link discovery ──────────────────────────────────────────────────

const PLATFORM_LINK_CACHE_FILE = path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'platform-links-cache.json',
);
const PLATFORM_LINK_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

type PlatformLinkEntry = {
  tablecheck_url: string | null;
  omakase_url: string | null;
  tableall_url: string | null;
  timestamp: number;
};
let platformLinkCache = new Map<string, PlatformLinkEntry>();

function loadPlatformLinkCache() {
  try {
    if (fs.existsSync(PLATFORM_LINK_CACHE_FILE)) {
      platformLinkCache = new Map(Object.entries(JSON.parse(fs.readFileSync(PLATFORM_LINK_CACHE_FILE, 'utf-8'))));
    }
  } catch { /* ignore */ }
}
function savePlatformLinkCache() {
  try {
    const dir = path.dirname(PLATFORM_LINK_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PLATFORM_LINK_CACHE_FILE, JSON.stringify(Object.fromEntries(platformLinkCache)));
  } catch { /* non-critical */ }
}
loadPlatformLinkCache();

const PLATFORMS = [
  { key: 'tablecheck_url' as const, domain: 'tablecheck.com', urlPattern: /tablecheck\.com\/(?:en\/)?([^/?]+)/ },
  { key: 'omakase_url' as const, domain: 'omakase.in', urlPattern: /omakase\.in\/([^/?]+)/ },
  { key: 'tableall_url' as const, domain: 'tableall.com', urlPattern: /tableall\.com\/restaurant\/(\d+)/ },
];

/**
 * Clean a Tabelog area/station name into a neighborhood suitable for search queries and cache keys.
 * "Higashi Ginza Sta." → "Ginza", "Roppongi Itchome Sta." → "Roppongi", "Akasaka Mitsuke Sta." → "Akasaka"
 */
function cleanAreaName(area: string): string {
  return area
    .replace(/\s*(Sta\.|Station|駅)\s*$/i, '')  // strip station suffix
    .replace(/^(Higashi|Nishi|Minami|Kita)\s+/i, '')  // strip directional prefix
    .replace(/\s+(Itchome|Nichome|Sanchome|Yonchome|Gochome|Mitsuke)\s*$/i, '')  // strip chome/mitsuke suffix
    .trim();
}

/**
 * Check platform link cache without making any network requests.
 * Returns null if not cached or expired.
 */
export function getCachedPlatformLinks(name: string, city: string, area?: string | null): { tablecheck_url: string | null; omakase_url: string | null; tableall_url: string | null } | null {
  const cleanedArea = area ? cleanAreaName(area) : null;
  const cacheKey = `${normalizeName(name)}:${city.toLowerCase()}${cleanedArea ? ':' + normalizeName(cleanedArea) : ''}`;
  const cached = platformLinkCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PLATFORM_LINK_TTL) {
    return { tablecheck_url: cached.tablecheck_url, omakase_url: cached.omakase_url, tableall_url: cached.tableall_url };
  }
  return null;
}

/**
 * Check if a Serper snippet is consistent with the expected area/address.
 * Returns true if the snippet confirms the location OR is inconclusive.
 * Returns false only when the snippet clearly contradicts expectations.
 */
function snippetMatchesLocation(snippet: string, area: string, address: string | null): boolean {
  const areaLower = area.toLowerCase();
  // Accept if snippet mentions the expected area (English or Japanese)
  if (snippet.toLowerCase().includes(areaLower) || snippet.includes(area)) return true;
  // Check address tokens (ward like 中央区, street like 銀座)
  if (address) {
    const tokens = address.match(/[^\s,、]+/g) || [];
    const significantTokens = tokens.filter(t => t.length >= 2);
    if (significantTokens.some(t => snippet.includes(t))) return true;
  }
  // Inconclusive — don't reject
  return true;
}

/**
 * Extract phone numbers from an HTML page. Looks for JSON-LD telephone field first,
 * then falls back to regex patterns for Japanese phone numbers.
 */
function extractPhonesFromHtml(html: string): string[] {
  // Try JSON-LD structured data first (most reliable)
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const block of jsonLdMatch) {
      const jsonStr = block.replace(/<\/?script[^>]*>/gi, '');
      try {
        const data = JSON.parse(jsonStr);
        const phone = data?.telephone || data?.phone;
        if (phone) return [String(phone)];
      } catch { /* skip invalid JSON */ }
    }
  }
  // Fallback: regex for Japanese phone patterns
  const patterns = html.match(/(?:\+?81|0)\d[\d\s\-().]{7,14}\d/g) || [];
  return [...new Set(patterns)];
}

/**
 * Fetch a page and extract its phone number(s). Lightweight — just HTTP GET + regex.
 */
async function fetchPhoneFromPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const phones = extractPhonesFromHtml(html);
    return phones.length > 0 ? phones[0]! : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a phone number to just digits for comparison.
 * Handles +81 (Japan country code) → 0 prefix, strips dashes/spaces/parens.
 */
function normalizePhone(phone: string): string {
  let digits = phone.replace(/[\s\-().+]/g, '');
  // Convert +81 country code to local format: 81312345678 → 0312345678
  if (digits.startsWith('81') && digits.length >= 10) {
    digits = '0' + digits.slice(2);
  }
  return digits;
}

/**
 * Verify a candidate platform URL by fetching the page and checking:
 * 1. Phone number match (if phone provided) — strongest signal
 * 2. Area/address match — checks if the page mentions the expected neighborhood
 * Returns true if verified or inconclusive, false if clearly a different restaurant.
 */
async function verifyCandidate(
  candidateUrl: string,
  opts: { phone?: string | null; area?: string | null; address?: string | null },
  name: string,
  platformKey: string,
): Promise<boolean> {
  // Skip verification if we have no data to verify against
  if (!opts.phone && !opts.area && !opts.address) return true;

  try {
    const res = await fetch(candidateUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return true; // can't verify → inconclusive
    const html = await res.text();

    // 1. Phone verification (strongest signal)
    if (opts.phone) {
      const expectedDigits = normalizePhone(opts.phone);
      if (expectedDigits.length >= 8) {
        const rawPhones = extractPhonesFromHtml(html);
        const pagePhones = rawPhones.map(normalizePhone).filter(p => p.length >= 9 && p.length <= 12);

        if (pagePhones.length > 0) {
          const phoneMatch = pagePhones.some(p =>
            p === expectedDigits || p.endsWith(expectedDigits.slice(-8)) || expectedDigits.endsWith(p.slice(-8))
          );
          if (phoneMatch) {
            console.log(`  [platform-discover] ${name} → ${platformKey}: phone VERIFIED ✓ (${opts.phone})`);
            return true;
          }
          // Phone mismatch — log warning but don't hard-reject.
          // Restaurants often use different phone numbers on different platforms
          // (reservation line vs general inquiry). Rely on area/address checks below.
          console.log(`  [platform-discover] ${name} → ${platformKey}: phone mismatch (expected=${expectedDigits}, page=${pagePhones.slice(0, 3).join(', ')}) — continuing to area check`);
        }
      }
    }

    // 2. Area verification — check if the page mentions the expected area/neighborhood
    if (opts.area) {
      const cleanedArea = cleanAreaName(opts.area);
      const htmlLower = html.toLowerCase();
      const expectedAreaLower = cleanedArea.toLowerCase();
      if (cleanedArea && htmlLower.includes(expectedAreaLower)) {
        console.log(`  [platform-discover] ${name} → ${platformKey}: area VERIFIED ✓ ("${cleanedArea}" found on page)`);
        return true;
      }
      // Partial area match: "Kitashinagawa" → also check "shinagawa" substring
      // Handles compound neighborhood names where platforms use the base area name
      if (cleanedArea && cleanedArea.length >= 8) {
        const suffixes = [cleanedArea.slice(4), cleanedArea.slice(3)].filter(s => s.length >= 4);
        if (suffixes.some(s => htmlLower.includes(s.toLowerCase()))) {
          console.log(`  [platform-discover] ${name} → ${platformKey}: area VERIFIED ✓ (partial match for "${cleanedArea}")`);
          return true;
        }
      }
      // Check Japanese area name too (e.g., 銀座)
      if (opts.address) {
        const tokens = opts.address.match(/[^\s,、]+/g) || [];
        const significant = tokens.filter(t => t.length >= 2);
        if (significant.some(t => html.includes(t))) {
          console.log(`  [platform-discover] ${name} → ${platformKey}: address token VERIFIED ✓`);
          return true;
        }
      }
      // Area not found on page — check if page has address-like content that hints at a different location
      // Look for common Tokyo area names on the page to see if it's a known different area
      const tokyoAreas = ['ginza', 'roppongi', 'shinjuku', 'shibuya', 'asakusa', 'akasaka', 'azabu', 'ebisu', 'meguro', 'nihonbashi', 'aoyama', 'ikebukuro', 'shinagawa'];
      const foundAreas = tokyoAreas.filter(a => a !== expectedAreaLower && !expectedAreaLower.includes(a) && htmlLower.includes(a));
      if (foundAreas.length > 0 && !htmlLower.includes(expectedAreaLower)) {
        console.log(`  [platform-discover] ${name} → ${platformKey}: area MISMATCH ✗ expected="${cleanedArea}", page mentions: ${foundAreas.join(', ')}`);
        return false;
      }
    }

    // Inconclusive
    return true;
  } catch (err) {
    console.log(`  [platform-discover] ${name} → ${platformKey}: verify failed (${err}), treating as inconclusive`);
    return true;
  }
}

/**
 * Discover which reservation platforms a restaurant is listed on.
 * Uses Serper to search Google for the restaurant on each platform domain.
 * When area is provided, uses it to narrow the search and verify results.
 * Results are cached for 30 days.
 */
export async function discoverPlatformLinks(
  name: string,
  city: string,
  area?: string | null,
  address?: string | null,
  phone?: string | null,
  tabelogUrl?: string | null,
): Promise<{ tablecheck_url: string | null; omakase_url: string | null; tableall_url: string | null }> {
  const cleanArea = area ? cleanAreaName(area) : null;
  const cacheKey = `${normalizeName(name)}:${city.toLowerCase()}${cleanArea ? ':' + normalizeName(cleanArea) : ''}`;
  const cached = platformLinkCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PLATFORM_LINK_TTL) {
    return { tablecheck_url: cached.tablecheck_url, omakase_url: cached.omakase_url, tableall_url: cached.tableall_url };
  }

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey || apiKey === 'your-serper-api-key-here') {
    console.log(`  [platform-discover] SKIP ${name} — no SERPER_API_KEY`);
    return { tablecheck_url: null, omakase_url: null, tableall_url: null };
  }

  const result: { tablecheck_url: string | null; omakase_url: string | null; tableall_url: string | null } = {
    tablecheck_url: null,
    omakase_url: null,
    tableall_url: null,
  };

  const citySlug = TABELOG_CITIES[city.toLowerCase()] || city.toLowerCase();
  // Use just the cleaned area — more specific than city, and the site: filter + quoted name
  // already constrain results enough. Adding city makes the query too restrictive.
  const locationTerm = cleanArea || citySlug;

  // Verify a Serper result title matches the restaurant name
  // Uses normalized word overlap — requires ALL significant name words to appear
  const nameNorm = normalizeName(name);
  const nameWords = nameNorm.split(' ').filter(w => w.length >= 2);
  const titleMatchesName = (title: string): boolean => {
    const titleNorm = normalizeName(title);
    // Check if the normalized name appears as a substring
    if (titleNorm.includes(nameNorm) || nameNorm.includes(titleNorm)) return true;
    // Check word overlap — ALL significant name words must appear in the title
    const titleWords = titleNorm.split(' ').filter(w => w.length >= 2);
    const shared = nameWords.filter(nw => titleWords.some(tw => tw.includes(nw) || nw.includes(tw)));
    return shared.length >= nameWords.length;
  };

  // If we don't have phone data but have a Tabelog URL, fetch the phone for verification.
  // This is a lightweight HTTP GET — only done once, shared across all platform checks.
  let resolvedPhone = phone;
  if (!resolvedPhone && tabelogUrl) {
    console.log(`  [platform-discover] ${name}: fetching phone from Tabelog page...`);
    resolvedPhone = await fetchPhoneFromPage(tabelogUrl);
    if (resolvedPhone) {
      console.log(`  [platform-discover] ${name}: got phone from Tabelog: ${resolvedPhone}`);
    }
  }

  // Reject non-dining listings (cake, takeaway, etc.) — same restaurant can have multiple platform pages
  const NON_DINING_KEYWORDS = /\b(cake|birthday|tart|takeaway|take-away|take away|delivery|gift|catering|bento|lunch box|sweets|pastry|patisserie|pâtisserie|gâteau|gateau)\b/i;
  const isDiningListing = (title: string, snippet?: string): boolean => {
    if (NON_DINING_KEYWORDS.test(title)) return false;
    // Only check snippet if title passed — snippets can mention "birthday" in generic text
    return true;
  };

  // Format phone for Serper query — use local format (03-6264-5855) for best Google matching
  let phoneForQuery: string | null = null;
  if (resolvedPhone) {
    const digits = normalizePhone(resolvedPhone);
    // Tokyo/Osaka 2-digit area: 0X-XXXX-XXXX
    if (/^0\d{9}$/.test(digits)) {
      phoneForQuery = `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
    }
    // 3-digit area: 0XX-XXX-XXXX
    else if (/^0\d{10}$/.test(digits)) {
      phoneForQuery = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    // Fallback: use the original format
    else {
      phoneForQuery = resolvedPhone;
    }
  }

  // Search all platforms in parallel
  await Promise.all(PLATFORMS.map(async (platform) => {
    try {
      // Pass 1: Phone-based search (most precise — phone uniquely identifies a restaurant)
      if (phoneForQuery) {
        const phoneQuery = `site:${platform.domain} "${name}" "${phoneForQuery}"`;
        console.log(`  [platform-discover] ${name} → ${platform.domain}: phone query="${phoneQuery}"`);
        const phoneRes = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: phoneQuery, num: 5 }),
        });
        if (phoneRes.ok) {
          const phoneData = await phoneRes.json() as { organic?: { link: string; title: string; snippet?: string }[] };
          const phoneMatch = phoneData.organic?.find(r => {
            if (!platform.urlPattern.test(r.link)) return false;
            if (!isDiningListing(r.title, r.snippet)) {
              console.log(`  [platform-discover] ${name} → ${platform.key}: SKIPPED non-dining listing "${r.title}"`);
              return false;
            }
            return true;
          });
          if (phoneMatch) {
            result[platform.key] = phoneMatch.link;
            console.log(`  [platform-discover] ${name} → ${platform.key}: ${phoneMatch.link} (PHONE MATCH ✓)`);
            return; // found via phone — skip name search
          }
        }
      }

      // Pass 2: Name+area search (fallback when phone search doesn't find anything)
      const query = `site:${platform.domain} "${name}" ${locationTerm}`;
      console.log(`  [platform-discover] ${name} → ${platform.domain}: name query="${query}"`);
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 5 }),
      });
      if (!res.ok) return;
      const data = await res.json() as { organic?: { link: string; title: string; snippet?: string }[] };
      const match = data.organic?.find(r => {
        if (!platform.urlPattern.test(r.link)) return false;
        if (!titleMatchesName(r.title)) return false;
        if (!isDiningListing(r.title, r.snippet)) {
          console.log(`  [platform-discover] ${name} → ${platform.key}: SKIPPED non-dining listing "${r.title}"`);
          return false;
        }
        // Area/address verification via snippet when we have area info
        if (area && r.snippet) {
          if (!snippetMatchesLocation(r.snippet, area, address ?? null)) {
            console.log(`  [platform-discover] ${name} → ${platform.key}: REJECTED snippet location mismatch (expected ${area}, snippet: "${r.snippet.slice(0, 100)}")`);
            return false;
          }
        }
        return true;
      });
      if (match) {
        // Verify candidate by fetching the page and checking phone/area/address
        const verified = await verifyCandidate(match.link, { phone: resolvedPhone, area, address }, name, platform.key);
        if (!verified) {
          console.log(`  [platform-discover] ${name} → ${platform.key}: REJECTED after page verification for ${match.link}`);
          return;
        }
        result[platform.key] = match.link;
        console.log(`  [platform-discover] ${name} → ${platform.key}: ${match.link} (title: "${match.title}")`);
      } else if (cleanArea && locationTerm !== citySlug) {
        // Pass 3: City-level fallback — area was too specific (e.g., "Kitashinagawa"), try broader city query
        // Still verified via titleMatchesName + isDiningListing + verifyCandidate
        const cityQuery = `site:${platform.domain} "${name}" ${citySlug}`;
        console.log(`  [platform-discover] ${name} → ${platform.domain}: city fallback query="${cityQuery}"`);
        const cityRes = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: cityQuery, num: 5 }),
        });
        if (!cityRes.ok) return;
        const cityData = await cityRes.json() as { organic?: { link: string; title: string; snippet?: string }[] };
        const cityMatch = cityData.organic?.find(r => {
          if (!platform.urlPattern.test(r.link)) return false;
          if (!titleMatchesName(r.title)) return false;
          if (!isDiningListing(r.title, r.snippet)) {
            console.log(`  [platform-discover] ${name} → ${platform.key}: SKIPPED non-dining listing "${r.title}" (city fallback)`);
            return false;
          }
          return true;
        });
        if (cityMatch) {
          const verified = await verifyCandidate(cityMatch.link, { phone: resolvedPhone, area, address }, name, platform.key);
          if (!verified) {
            console.log(`  [platform-discover] ${name} → ${platform.key}: REJECTED after page verification for ${cityMatch.link} (city fallback)`);
            return;
          }
          result[platform.key] = cityMatch.link;
          console.log(`  [platform-discover] ${name} → ${platform.key}: ${cityMatch.link} (city fallback, title: "${cityMatch.title}")`);
        } else {
          const urlMatch = cityData.organic?.find(r => platform.urlPattern.test(r.link));
          if (urlMatch) {
            console.log(`  [platform-discover] ${name} → ${platform.key}: REJECTED "${urlMatch.title}" (city fallback, title/dining mismatch)${urlMatch.snippet ? ` snippet: "${urlMatch.snippet.slice(0, 80)}"` : ''}`);
          }
        }
      } else {
        // Log rejected results for debugging
        const urlMatch = data.organic?.find(r => platform.urlPattern.test(r.link));
        if (urlMatch) {
          console.log(`  [platform-discover] ${name} → ${platform.key}: REJECTED "${urlMatch.title}" (title/snippet mismatch)${urlMatch.snippet ? ` snippet: "${urlMatch.snippet.slice(0, 80)}"` : ''}`);
        }
      }
    } catch (err) {
      console.log(`  [platform-discover] ${name} ${platform.domain} search failed: ${err}`);
    }
  }));

  platformLinkCache.set(cacheKey, { ...result, timestamp: Date.now() });
  savePlatformLinkCache();

  console.log(`  [platform-discover] ${name}${area ? ` (${area})` : ''}: TC=${result.tablecheck_url ? 'yes' : 'no'} OM=${result.omakase_url ? 'yes' : 'no'} TA=${result.tableall_url ? 'yes' : 'no'}`);
  return result;
}
