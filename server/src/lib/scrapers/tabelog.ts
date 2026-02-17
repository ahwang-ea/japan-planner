import { chromium, type Browser, type Page } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

let anthropicClient: Anthropic | null = null;
let anthropicWarned = false;
function getAnthropic(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) {
    if (!anthropicWarned) {
      console.log('  [platform-discover] WARN: no ANTHROPIC_API_KEY — LLM matching disabled');
      anthropicWarned = true;
    }
    return null;
  }
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

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

const KNOWN_AREAS = new Set([
  // Tokyo
  'ginza', 'roppongi', 'shinjuku', 'shibuya', 'asakusa', 'akasaka', 'azabu',
  'ebisu', 'meguro', 'nihonbashi', 'aoyama', 'ikebukuro', 'shinagawa',
  'hibiya', 'yurakucho', 'marunouchi', 'ueno', 'kanda', 'tsukiji',
  'nakameguro', 'daikanyama', 'omotesando', 'harajuku', 'shimokitazawa',
  'nishiazabu', 'hiroo', 'azabujuban', 'toranomon', 'shimbashi',
  // Osaka
  'namba', 'umeda', 'shinsaibashi', 'dotombori', 'tennoji', 'kitashinchi',
  // Kyoto
  'gion', 'kawaramachi', 'pontocho', 'kiyamachi',
]);

/**
 * Strip a trailing location/area word from a restaurant name for broader search queries.
 * "Sushi Nanba Hibiya" → "Sushi Nanba" (when area is Yurakucho/Hibiya).
 * Only affects search — the full name is still passed to the LLM for matching.
 */
function stripLocationSuffix(name: string, area?: string | null): string {
  const words = name.split(/\s+/);
  if (words.length < 2) return name;
  const lastWord = words[words.length - 1]!.toLowerCase();
  const cleanedArea = area ? cleanAreaName(area).toLowerCase() : null;
  if (
    (cleanedArea && (lastWord === cleanedArea || cleanedArea.includes(lastWord) || lastWord.includes(cleanedArea))) ||
    KNOWN_AREAS.has(lastWord)
  ) {
    return words.slice(0, -1).join(' ');
  }
  return name;
}

/**
 * Ask Haiku to match a restaurant against search result candidates.
 * Returns the index of the matching candidate, or -1 if no match.
 */
async function llmMatchRestaurant(
  restaurant: { name: string; area?: string | null; city: string; phone?: string | null; address?: string | null },
  candidates: { title: string; link: string; snippet?: string }[],
): Promise<number> {
  const client = getAnthropic();
  if (!client || candidates.length === 0) return -1;

  const candidateLines = candidates.map((c, i) =>
    `${i + 1}. Title: "${c.title}" | URL: ${c.link}${c.snippet ? ` | Snippet: "${c.snippet}"` : ''}`
  ).join('\n');

  const ref = [
    `Name: ${restaurant.name}`,
    restaurant.area && `Area: ${restaurant.area}`,
    `City: ${restaurant.city}`,
    restaurant.phone && `Phone: ${restaurant.phone}`,
    restaurant.address && `Address: ${restaurant.address}`,
  ].filter(Boolean).join('\n');

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 24,
      messages: [{
        role: 'user',
        content: `Which search result is the SAME restaurant as the reference? Restaurant names may differ slightly across platforms (location suffixes, abbreviations, romanization). Ignore non-dining listings (cakes, takeaway, delivery, catering). Reply with ONLY a single number or the word "none". Nothing else.

Reference restaurant:
${ref}

Search results:
${candidateLines}`,
      }],
    });

    const text = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : '';
    const num = parseInt(text, 10);
    if (num >= 1 && num <= candidates.length) return num - 1;
    return -1;
  } catch (err) {
    console.log(`  [platform-discover] LLM match failed: ${err}`);
    return -1;
  }
}

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
 * Discover which reservation platforms a restaurant is listed on.
 * Uses Serper to search Google for candidates, then Haiku LLM to match.
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
  const locationTerm = cleanArea || citySlug;
  const searchName = stripLocationSuffix(name, area);

  // If we don't have phone data but have a Tabelog URL, fetch the phone for search queries.
  let resolvedPhone = phone;
  if (!resolvedPhone && tabelogUrl) {
    console.log(`  [platform-discover] ${name}: fetching phone from Tabelog page...`);
    resolvedPhone = await fetchPhoneFromPage(tabelogUrl);
    if (resolvedPhone) {
      console.log(`  [platform-discover] ${name}: got phone from Tabelog: ${resolvedPhone}`);
    }
  }

  // Format phone for Serper query — use local format (03-6264-5855) for best Google matching
  let phoneForQuery: string | null = null;
  if (resolvedPhone) {
    const digits = normalizePhone(resolvedPhone);
    if (/^0\d{9}$/.test(digits)) {
      phoneForQuery = `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
    } else if (/^0\d{10}$/.test(digits)) {
      phoneForQuery = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    } else {
      phoneForQuery = resolvedPhone;
    }
  }

  const serperSearch = async (query: string) => {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { organic?: { link: string; title: string; snippet?: string }[] };
    return data.organic || [];
  };

  // Search all platforms in parallel, use LLM to match candidates
  await Promise.all(PLATFORMS.map(async (platform) => {
    try {
      const candidates: { title: string; link: string; snippet?: string }[] = [];
      const seenUrls = new Set<string>();
      const addCandidates = (organic: { link: string; title: string; snippet?: string }[]) => {
        for (const r of organic) {
          if (platform.urlPattern.test(r.link) && !seenUrls.has(r.link)) {
            seenUrls.add(r.link);
            candidates.push(r);
          }
        }
      };

      // Search 1: Name + location (unquoted for fuzzy matching)
      const nameQuery = `site:${platform.domain} ${searchName} ${locationTerm}`;
      console.log(`  [platform-discover] ${name} → ${platform.domain}: query="${nameQuery}"`);
      addCandidates(await serperSearch(nameQuery));

      // Search 2: Phone only (if available — unique identifier)
      if (phoneForQuery) {
        const phoneQuery = `site:${platform.domain} ${phoneForQuery}`;
        console.log(`  [platform-discover] ${name} → ${platform.domain}: phone="${phoneQuery}"`);
        addCandidates(await serperSearch(phoneQuery));
      }

      if (candidates.length === 0) return;

      console.log(`  [platform-discover] ${name} → ${platform.key}: ${candidates.length} candidate(s), asking LLM...`);
      const matchIdx = await llmMatchRestaurant(
        { name, area: cleanArea, city, phone: resolvedPhone, address },
        candidates,
      );
      if (matchIdx >= 0) {
        result[platform.key] = candidates[matchIdx]!.link;
        console.log(`  [platform-discover] ${name} → ${platform.key}: ${candidates[matchIdx]!.link} (LLM MATCH ✓)`);
      } else {
        console.log(`  [platform-discover] ${name} → ${platform.key}: no match`);
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

// ── Photo scraping ───────────────────────────────────────────────────────────

export interface PhotoCategory {
  id: string;       // e.g. 'all', 'food', 'interior', 'exterior', 'drinks', 'other'
  label: string;    // e.g. 'All', 'Food', 'Interior'
  count: number;
}

export interface TabelogPhotos {
  photos: string[];
  totalCount: number;
  categories: PhotoCategory[];
  category: string;  // which category was scraped
  scrapedAt: string;
}

const PHOTO_CACHE_FILE = path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'tabelog-photos-cache.json',
);
const PHOTO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

type PhotoCacheEntry = TabelogPhotos & { timestamp: number };
let photoCache = new Map<string, PhotoCacheEntry>();

function loadPhotoCache() {
  try {
    if (fs.existsSync(PHOTO_CACHE_FILE)) {
      photoCache = new Map(Object.entries(JSON.parse(fs.readFileSync(PHOTO_CACHE_FILE, 'utf-8'))));
    }
  } catch { /* ignore */ }
}
function savePhotoCache() {
  try {
    const dir = path.dirname(PHOTO_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PHOTO_CACHE_FILE, JSON.stringify(Object.fromEntries(photoCache)));
  } catch { /* non-critical */ }
}
loadPhotoCache();

/**
 * Convert an English Tabelog URL to the Japanese equivalent.
 * Photo and review pages only exist on the Japanese site.
 */
function toJapaneseUrl(url: string): string {
  return url.replace('tabelog.com/en/', 'tabelog.com/');
}

/**
 * Upgrade a Tabelog thumbnail URL to a larger version.
 * "320x320_rect_81227.jpg" → "640x640_rect_81227.jpg"
 * Already-large or full-size URLs are returned unchanged.
 */
function upgradeThumbnail(url: string): string {
  return url.replace(/\/\d+x\d+(?:_rect|_square)?_/, '/640x640_rect_');
}

// Tabelog photo category URL path segments
// dtlphotolst/smp2/ = all, 1/smp2/ = food, 3/smp2/ = interior, 4/smp2/ = exterior, 5/smp2/ = other, 7/smp2/ = drinks
const PHOTO_CATEGORY_MAP: Record<string, { pathSegment: string; label: string; jpLabel: string }> = {
  all:      { pathSegment: '',  label: 'All',      jpLabel: 'すべて' },
  food:     { pathSegment: '1', label: 'Food',     jpLabel: '料理' },
  drinks:   { pathSegment: '7', label: 'Drinks',   jpLabel: 'ドリンク' },
  interior: { pathSegment: '3', label: 'Interior', jpLabel: '内観' },
  exterior: { pathSegment: '4', label: 'Exterior', jpLabel: '外観' },
  other:    { pathSegment: '5', label: 'Other',    jpLabel: 'その他' },
};

/**
 * Parse photo category counts from the nav sublist on a photo page.
 */
function parsePhotoCategories($: cheerio.CheerioAPI): PhotoCategory[] {
  const categories: PhotoCategory[] = [];
  const navLinks = $('a[href*="dtlphotolst"]');
  for (const [id, meta] of Object.entries(PHOTO_CATEGORY_MAP)) {
    navLinks.each((_i, el) => {
      const text = $(el).text().trim();
      if (text.includes(meta.jpLabel)) {
        const countMatch = text.match(/(\d+)/);
        const count = countMatch ? parseInt(countMatch[1]!, 10) : 0;
        if (!categories.find(c => c.id === id)) {
          categories.push({ id, label: meta.label, count });
        }
      }
    });
  }
  return categories;
}

/**
 * Extract photo URLs from a cheerio-parsed photo page.
 */
function extractPhotosFromPage($: cheerio.CheerioAPI, seen: Set<string>): string[] {
  const photos: string[] = [];
  // Primary: link targets in imagebox triggers (these point to larger images)
  $('a.js-imagebox-trigger').each((_i, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('tblg.k-img.com') && !seen.has(href)) {
      seen.add(href);
      photos.push(upgradeThumbnail(href));
    }
  });
  // Fallback: image elements in the photo list
  if (photos.length === 0) {
    $('.rstdtl-photo-list__img img, .rstdtl-photo-list img').each((_i, el) => {
      for (const attr of ['data-original', 'data-lazy', 'data-src', 'src']) {
        const val = $(el).attr(attr);
        if (val && val.includes('tblg.k-img.com') && !val.includes('no_image') && !seen.has(val)) {
          seen.add(val);
          photos.push(upgradeThumbnail(val));
          break;
        }
      }
    });
  }
  return photos;
}

/**
 * Scrape photos from a Tabelog restaurant's photo gallery.
 * Supports category filtering (food, interior, exterior, drinks, other).
 * Uses the small grid view (smp2, 40 items/page) for efficient scraping.
 * Paginates through all pages to collect the full set.
 */
export async function scrapeTabelogPhotos(tabelogUrl: string, category: string = 'all'): Promise<TabelogPhotos> {
  const cacheKey = `${tabelogUrl}:${category}`;
  const cached = photoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PHOTO_CACHE_TTL) {
    console.log(`  [photos] CACHE HIT ${tabelogUrl} cat=${category} (${cached.photos.length} photos)`);
    return { photos: cached.photos, totalCount: cached.totalCount, categories: cached.categories, category: cached.category, scrapedAt: cached.scrapedAt };
  }

  const baseUrl = toJapaneseUrl(tabelogUrl.replace(/\/$/, ''));
  const catMeta = PHOTO_CATEGORY_MAP[category] || PHOTO_CATEGORY_MAP.all!;
  const catPath = catMeta.pathSegment ? `${catMeta.pathSegment}/` : '';

  const allPhotos: string[] = [];
  const seen = new Set<string>();
  let totalCount = 0;
  let categories: PhotoCategory[] = [];
  let page = 1;
  const MAX_PAGES = 15;

  while (page <= MAX_PAGES) {
    // Use smp2 (small grid, 40 per page) for efficient scraping
    const pageUrl = page === 1
      ? `${baseUrl}/dtlphotolst/${catPath}smp2/`
      : `${baseUrl}/dtlphotolst/${catPath}smp2/?smp=0&sby=D&srt=normal&PG=${page}`;

    console.log(`  [photos] FETCH ${pageUrl}`);
    let html: string;
    try {
      const res = await fetch(pageUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) break;
      html = await res.text();
    } catch {
      break;
    }

    const $ = cheerio.load(html);

    // Extract total count and categories on first page
    if (page === 1) {
      // Total from page count display
      const countEl = $('span.c-page-count__num').last().text().trim();
      if (countEl) totalCount = parseInt(countEl, 10) || 0;
      // Fallback from title
      if (totalCount === 0) {
        const titleMatch = $('title').text().match(/写真.*?(\d+)/);
        if (titleMatch) totalCount = parseInt(titleMatch[1]!, 10);
      }
      categories = parsePhotoCategories($);
    }

    const pagePhotos = extractPhotosFromPage($, seen);
    allPhotos.push(...pagePhotos);

    console.log(`  [photos] page ${page}: ${pagePhotos.length} photos (total so far: ${allPhotos.length})`);

    // Check for next page
    const hasNext = $('a.c-pagination__arrow--next').length > 0;
    if (!hasNext || pagePhotos.length === 0) break;
    page++;
  }

  if (totalCount === 0) totalCount = allPhotos.length;
  const result: TabelogPhotos = { photos: allPhotos, totalCount, categories, category, scrapedAt: new Date().toISOString() };
  photoCache.set(cacheKey, { ...result, timestamp: Date.now() });
  savePhotoCache();
  console.log(`  [photos] ${tabelogUrl} cat=${category}: ${allPhotos.length} photos scraped (total available: ${totalCount})`);
  return result;
}

// ── Review scraping ──────────────────────────────────────────────────────────

export interface TabelogReview {
  author: string | null;
  rating: number | null;
  date: string | null;
  title: string | null;
  body: string;
  visitDate: string | null;
  mealType: string | null;
  priceRange: string | null;
  photos: string[];
  reviewUrl?: string | null;
  photoCount?: number;
  title_en?: string | null;
  body_en?: string | null;
}

export interface TabelogReviews {
  reviews: TabelogReview[];
  totalCount: number;
  averageScore: number | null;
  scrapedAt: string;
}

const REVIEW_CACHE_FILE = path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'tabelog-reviews-cache.json',
);
const REVIEW_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

type ReviewCacheEntry = TabelogReviews & { timestamp: number };
let reviewCache = new Map<string, ReviewCacheEntry>();

function loadReviewCache() {
  try {
    if (fs.existsSync(REVIEW_CACHE_FILE)) {
      reviewCache = new Map(Object.entries(JSON.parse(fs.readFileSync(REVIEW_CACHE_FILE, 'utf-8'))));
    }
  } catch { /* ignore */ }
}
function saveReviewCache() {
  try {
    const dir = path.dirname(REVIEW_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REVIEW_CACHE_FILE, JSON.stringify(Object.fromEntries(reviewCache)));
  } catch { /* non-critical */ }
}
loadReviewCache();

// ── Translation cache ────────────────────────────────────────────────────────

const TRANSLATION_CACHE_FILE = path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'tabelog-translations-cache.json',
);
const TRANSLATION_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

type TranslationCacheEntry = { title_en: string | null; body_en: string | null; timestamp: number };
let translationCache = new Map<string, TranslationCacheEntry>();

function loadTranslationCache() {
  try {
    if (fs.existsSync(TRANSLATION_CACHE_FILE)) {
      translationCache = new Map(Object.entries(JSON.parse(fs.readFileSync(TRANSLATION_CACHE_FILE, 'utf-8'))));
    }
  } catch { /* ignore */ }
}
function saveTranslationCache() {
  try {
    const dir = path.dirname(TRANSLATION_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TRANSLATION_CACHE_FILE, JSON.stringify(Object.fromEntries(translationCache)));
  } catch { /* non-critical */ }
}
loadTranslationCache();

function translationKey(title: string | null, body: string): string {
  const content = `${title || ''}|||${body.slice(0, 200)}`;
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

async function translateBatch(
  client: Anthropic,
  reviews: TabelogReview[],
): Promise<{ title_en: string | null; body_en: string }[]> {
  const reviewsPayload = reviews.map((r, i) => ({
    id: i + 1,
    title: r.title || '',
    body: r.body.slice(0, 2000),
  }));

  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Translate these Japanese restaurant reviews to natural English. Preserve the tone and meaning. Return a JSON array with objects containing "id", "title_en", and "body_en" for each review. If a title is empty, set title_en to null.

Reviews:
${JSON.stringify(reviewsPayload, null, 2)}

Respond with ONLY valid JSON array, no other text.`,
    }],
  });

  let text = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : '[]';
  // Strip markdown code fences if present
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }
  let parsed: { id: number; title_en: string | null; body_en: string }[];
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log(`  [translate] failed to parse LLM response as JSON: ${text.slice(0, 200)}`);
    return reviews.map(() => ({ title_en: null, body_en: '' }));
  }

  return reviews.map((_, i) => {
    const match = parsed.find(p => p.id === i + 1);
    return match
      ? { title_en: match.title_en, body_en: match.body_en }
      : { title_en: null, body_en: '' };
  });
}

/**
 * Translate review titles and bodies from Japanese to English using Claude Haiku.
 * Batches multiple reviews per LLM call for efficiency.
 * Results are cached for 30 days independently of the review scrape cache.
 * Optional onBatch callback streams translated batches as they complete.
 */
export async function translateReviews(
  reviews: TabelogReview[],
  onBatch?: (translated: TabelogReview[]) => void,
): Promise<TabelogReview[]> {
  const client = getAnthropic();
  if (!client) return reviews;

  const result: TabelogReview[] = [...reviews];
  const needsTranslation: { index: number; review: TabelogReview }[] = [];

  // Apply cached translations
  const cachedBatch: TabelogReview[] = [];
  for (let i = 0; i < reviews.length; i++) {
    const review = reviews[i]!;
    const key = translationKey(review.title, review.body);
    const cached = translationCache.get(key);
    if (cached && Date.now() - cached.timestamp < TRANSLATION_CACHE_TTL) {
      result[i] = { ...review, title_en: cached.title_en, body_en: cached.body_en };
      cachedBatch.push(result[i]!);
    } else {
      needsTranslation.push({ index: i, review });
    }
  }

  // Stream cached translations immediately
  if (cachedBatch.length > 0 && onBatch) {
    onBatch(cachedBatch);
  }

  if (needsTranslation.length === 0) {
    console.log(`  [translate] all ${reviews.length} reviews cached`);
    return result;
  }

  console.log(`  [translate] ${reviews.length - needsTranslation.length} cached, translating ${needsTranslation.length}...`);

  const BATCH_SIZE = 5;
  for (let batchStart = 0; batchStart < needsTranslation.length; batchStart += BATCH_SIZE) {
    const batch = needsTranslation.slice(batchStart, batchStart + BATCH_SIZE);
    try {
      const translations = await translateBatch(client, batch.map(b => b.review));
      const batchResult: TabelogReview[] = [];
      for (let j = 0; j < batch.length; j++) {
        const { index, review } = batch[j]!;
        const translation = translations[j];
        if (translation && (translation.title_en || translation.body_en)) {
          result[index] = { ...review, title_en: translation.title_en, body_en: translation.body_en };
          const key = translationKey(review.title, review.body);
          translationCache.set(key, { ...translation, timestamp: Date.now() });
          batchResult.push(result[index]!);
        }
      }
      if (batchResult.length > 0 && onBatch) {
        onBatch(batchResult);
      }
    } catch (err) {
      console.log(`  [translate] batch failed: ${err}`);
    }
  }

  saveTranslationCache();
  return result;
}

/**
 * Scrape all reviews from a Tabelog restaurant's review page.
 * Paginates through all pages to collect the complete review set.
 */
export async function scrapeTabelogReviews(
  tabelogUrl: string,
  onPage?: (pageReviews: TabelogReview[], page: number, totalCount: number, averageScore: number | null) => void,
): Promise<TabelogReviews> {
  const cached = reviewCache.get(tabelogUrl);
  if (cached && Date.now() - cached.timestamp < REVIEW_CACHE_TTL) {
    console.log(`  [reviews] CACHE HIT ${tabelogUrl} (${cached.reviews.length} reviews)`);
    return { reviews: cached.reviews, totalCount: cached.totalCount, averageScore: cached.averageScore, scrapedAt: cached.scrapedAt };
  }

  const baseUrl = toJapaneseUrl(tabelogUrl.replace(/\/$/, ''));
  const allReviews: TabelogReview[] = [];
  let totalCount = 0;
  let averageScore: number | null = null;
  let page = 1;
  const MAX_PAGES = 20;

  while (page <= MAX_PAGES) {
    const pageUrl = page === 1
      ? `${baseUrl}/dtlrvwlst/`
      : `${baseUrl}/dtlrvwlst/COND-0/smp1/?lc=0&rvw_part=all&PG=${page}`;

    console.log(`  [reviews] FETCH ${pageUrl}`);
    let html: string;
    try {
      const res = await fetch(pageUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) break;
      html = await res.text();
    } catch {
      break;
    }

    const $ = cheerio.load(html);

    // Extract total count and average score on first page
    if (page === 1) {
      const titleText = $('title').text();
      const countMatch = titleText.match(/口コミ.*?(\d+)/);
      if (countMatch) totalCount = parseInt(countMatch[1]!, 10);
      // Also try from meta description
      if (totalCount === 0) {
        const descText = $('meta[name="description"]').attr('content') || '';
        const descMatch = descText.match(/口コミ(\d+)件/);
        if (descMatch) totalCount = parseInt(descMatch[1]!, 10);
      }
      // Average score from header
      const scoreText = $('.rdheader-rating__score-val-dtl').first().text().trim();
      if (scoreText) {
        const parsed = parseFloat(scoreText);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 5) averageScore = parsed;
      }
    }

    // Parse review items
    let pageReviews = 0;
    $('.rvw-item.js-rvw-item-clickable-area').each((_i, el) => {
      const item = $(el);

      // Author
      const author = item.find('.rvw-item__rvwr-name a').first().text().trim() || null;

      // Rating — from the total rating value
      let rating: number | null = null;
      const ratingText = item.find('.rvw-item__ratings-total .c-rating-v3__val').first().text().trim();
      if (ratingText) {
        const parsed = parseFloat(ratingText);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 5) rating = parsed;
      }
      // Fallback: extract from class like c-rating-v3--val35
      if (!rating) {
        const ratingClass = item.find('.rvw-item__ratings-total').attr('class') || '';
        const valMatch = ratingClass.match(/c-rating-v3--val(\d+)/);
        if (valMatch) rating = parseInt(valMatch[1]!, 10) / 10;
      }

      // Date
      const date = item.find('.rvw-item__date').first().text().trim() || null;

      // Title
      const title = item.find('.rvw-item__title-target').first().text().trim() || null;

      // Body — full text from comment div
      const commentEl = item.find('.rvw-item__rvw-comment');
      // Remove hidden "show more" elements and get text
      commentEl.find('.rvw-item__more').remove();
      const body = commentEl.text().trim();

      // Price range
      const priceRange = item.find('.rvw-item__payment-amount').first().text().trim() || null;

      // Visit info / meal type
      let visitDate: string | null = null;
      let mealType: string | null = null;
      const visitText = item.find('.rvw-item__rvw-info').text();
      const visitMatch = visitText.match(/(\d{4}\/\d{2})/);
      if (visitMatch) visitDate = visitMatch[1]!;
      if (/ランチ|lunch/i.test(visitText)) mealType = 'lunch';
      else if (/ディナー|dinner/i.test(visitText)) mealType = 'dinner';

      // Reviewer photos (list page shows max 3)
      const photos: string[] = [];
      item.find('.rvw-photo a.js-imagebox-trigger').each((_j, photoEl) => {
        const href = $(photoEl).attr('href');
        if (href && href.includes('tblg.k-img.com')) {
          photos.push(upgradeThumbnail(href));
        }
      });

      // Individual review URL + total photo count
      const reviewHref = item.find('.rvw-item__title a, a.rvw-item__title-target').first().attr('href') || null;
      const reviewUrl = reviewHref ? new URL(reviewHref, 'https://tabelog.com').href : null;
      const moreNum = parseInt(item.find('.c-photo-more__num').text().trim(), 10);
      const photoCount = photos.length + (isNaN(moreNum) ? 0 : moreNum);

      if (body) {
        allReviews.push({ author, rating, date, title, body, visitDate, mealType, priceRange, photos, reviewUrl, photoCount });
        pageReviews++;
      }
    });

    console.log(`  [reviews] page ${page}: ${pageReviews} reviews (total so far: ${allReviews.length})`);
    if (pageReviews > 0 && onPage) {
      onPage(allReviews.slice(-pageReviews), page, totalCount, averageScore);
    }

    // Check for next page
    const hasNext = $('a.c-pagination__arrow--next').length > 0;
    if (!hasNext || pageReviews === 0) break;
    page++;
  }

  if (totalCount === 0) totalCount = allReviews.length;
  const result: TabelogReviews = { reviews: allReviews, totalCount, averageScore, scrapedAt: new Date().toISOString() };
  reviewCache.set(tabelogUrl, { ...result, timestamp: Date.now() });
  saveReviewCache();
  console.log(`  [reviews] ${tabelogUrl}: ${allReviews.length} reviews scraped (total available: ${totalCount})`);
  return result;
}

/**
 * Scrape all photos from an individual Tabelog review page.
 * The page may contain multiple visits by the same reviewer —
 * bodyHint matches the correct visit's comment to return only its photos.
 */
export async function scrapeReviewPhotos(reviewUrl: string, bodyHint?: string): Promise<string[]> {
  console.log(`  [review-photos] FETCH ${reviewUrl}`);
  try {
    const res = await fetch(reviewUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    // Match the specific visit by body text, then take its adjacent photo section
    if (bodyHint) {
      const hint = bodyHint.slice(0, 40);
      let matched = false;
      const comments = $('.rvw-item__rvw-comment');
      for (let i = 0; i < comments.length; i++) {
        const commentText = $(comments[i]!).text().trim();
        if (commentText.includes(hint)) {
          // The photo section immediately follows the comment in the DOM
          const photoSection = $(comments[i]!).next('.rvw-photo');
          if (photoSection.length) {
            const photos: string[] = [];
            photoSection.find('a.js-imagebox-trigger').each((_j, el) => {
              const href = $(el).attr('href');
              if (href && href.includes('tblg.k-img.com')) {
                photos.push(upgradeThumbnail(href));
              }
            });
            console.log(`  [review-photos] matched visit ${i + 1}: ${photos.length} photos`);
            matched = true;
            return photos;
          }
        }
      }
      if (!matched) console.log(`  [review-photos] no body match found, returning all`);
    }

    // Fallback: return all photos on the page
    const photos: string[] = [];
    $('.rvw-photo a.js-imagebox-trigger').each((_i, el) => {
      const href = $(el).attr('href');
      if (href && href.includes('tblg.k-img.com')) {
        photos.push(upgradeThumbnail(href));
      }
    });
    console.log(`  [review-photos] ${photos.length} photos found (all)`);
    return photos;
  } catch (err) {
    console.log(`  [review-photos] failed: ${err}`);
    return [];
  }
}
