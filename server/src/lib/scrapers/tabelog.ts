import { chromium, type Browser, type Page } from 'playwright';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    });
  }
  return browser;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
}

export interface TabelogListResult {
  restaurants: TabelogData[];
  page: number;
  hasNextPage: boolean;
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

// Cache: key = "city:page", value = { data, timestamp }
const browseCache = new Map<string, { data: TabelogListResult; timestamp: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function textOf(page: Page, selector: string, parent?: string): Promise<string | null> {
  const loc = parent ? page.locator(parent).locator(selector) : page.locator(selector);
  const first = loc.first();
  try {
    return (await first.textContent({ timeout: 500 }))?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Browse Tabelog ranking page for a city, sorted by score.
 * Uses Playwright locators (server-side) to avoid tsx/evaluate issues.
 */
export async function browseTabelog(city: string, page: number = 1, refresh: boolean = false): Promise<TabelogListResult> {
  const cacheKey = `${city.toLowerCase()}:${page}`;
  if (!refresh) {
    const cached = browseCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const citySlug = TABELOG_CITIES[city.toLowerCase()] || city.toLowerCase();
  const url = page === 1
    ? `https://tabelog.com/en/${citySlug}/rstLst/?SrtT=rt`
    : `https://tabelog.com/en/${citySlug}/rstLst/${page}/?SrtT=rt`;

  const b = await getBrowser();
  const context = await b.newContext({ userAgent: UA });
  const pageObj = await context.newPage();

  try {
    await pageObj.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageObj.waitForTimeout(3000);

    // Use locators to extract data server-side (avoids tsx __name issue with evaluate)
    const items = pageObj.locator('.list-rst');
    const count = await items.count();

    const seenUrls = new Map<string, TabelogData>();

    for (let i = 0; i < count; i++) {
      const item = items.nth(i);

      // Name & URL
      const nameEl = item.locator('.list-rst__rst-name-target').first();
      let name: string | null = null;
      let tabelogUrl: string | null = null;
      try {
        name = (await nameEl.textContent({ timeout: 500 }))?.trim() || null;
        tabelogUrl = await nameEl.getAttribute('href') || null;
      } catch { /* skip */ }

      if (!name) continue;

      // Score
      let score: number | null = null;
      const scoreEl = item.locator('.c-rating__val, .list-rst__rating-val').first();
      try {
        const scoreText = (await scoreEl.textContent({ timeout: 500 }))?.trim();
        if (scoreText) {
          const parsed = parseFloat(scoreText);
          if (!isNaN(parsed) && parsed > 0 && parsed <= 5) score = parsed;
        }
      } catch { /* no score */ }

      // Area & Cuisine from combined "Station / Cuisine" element
      let area: string | null = null;
      let cuisine: string | null = null;
      try {
        const areaGenreText = (await item.locator('.list-rst__area-genre').first().textContent({ timeout: 500 }))?.trim();
        if (areaGenreText) {
          const parts = areaGenreText.split('/');
          area = parts[0]?.trim() || null;
          cuisine = parts[1]?.trim() || null;
        }
      } catch { /* skip */ }

      // Price range
      let priceRange: string | null = null;
      try {
        const budgetEls = item.locator('.list-rst__budget');
        const budgetCount = await budgetEls.count();
        const prices: string[] = [];
        for (let j = 0; j < budgetCount; j++) {
          const t = (await budgetEls.nth(j).textContent({ timeout: 500 }))?.trim();
          if (t) prices.push(t);
        }
        priceRange = prices.join(' / ') || null;
      } catch { /* skip */ }

      const entry: TabelogData = {
        name, name_ja: null, tabelog_url: tabelogUrl, tabelog_score: score,
        cuisine, area, city, address: null, phone: null,
        price_range: priceRange, hours: null,
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
    }

    // Check for next page
    const nextLink = pageObj.locator('a.c-pagination__arrow--next').first();
    let hasNextPage = false;
    try {
      hasNextPage = await nextLink.isVisible({ timeout: 500 });
    } catch { /* no next */ }

    const result: TabelogListResult = {
      restaurants: Array.from(seenUrls.values()),
      page,
      hasNextPage,
    };

    browseCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } finally {
    await context.close();
  }
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

    return {
      name, name_ja: nameJa, tabelog_url: url,
      tabelog_score: score, cuisine, area, city, address, phone,
      price_range: priceRange, hours: null,
    };
  } finally {
    await context.close();
  }
}
