import fs from 'fs';
import path from 'path';
import { getBrowser, UA } from './tabelog.js';

export interface DateAvailability {
  date: string;       // YYYY-MM-DD
  status: 'available' | 'limited' | 'unavailable' | 'unknown';
  timeSlots: string[];
}

export interface ReservationAvailability {
  tabelogUrl: string;
  hasOnlineReservation: boolean;
  reservationUrl: string | null;
  dates: DateAvailability[];
  checkedAt: string;
  error?: string;
}

// File-backed cache with 4-hour TTL
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const CACHE_FILE = path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'tabelog-availability-cache.json'
);

type CacheEntry = { data: ReservationAvailability; timestamp: number };
let availabilityCache = new Map<string, CacheEntry>();

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, CacheEntry>;
      availabilityCache = new Map(Object.entries(raw));
    }
  } catch { /* ignore corrupt cache */ }
}

function saveCache() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(availabilityCache)));
  } catch { /* non-critical */ }
}

loadCache();

export function toJapaneseUrl(url: string): string {
  return url.replace('tabelog.com/en/', 'tabelog.com/');
}

/**
 * Fast HTTP pre-check: fetch the restaurant page HTML and look for
 * booking-calendar or rstdtl-side-yoyaku__booking which only appear
 * on restaurants with online reservations (~500ms vs 5-10s Playwright).
 */
async function quickBookingCheck(jaUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(jaUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return false;
    const html = await resp.text();
    return html.includes('booking-calendar') || html.includes('rstdtl-side-yoyaku__booking');
  } catch {
    return false; // network error — can't tell, assume no
  }
}

export async function scrapeReservationAvailability(
  tabelogUrl: string,
  refresh: boolean = false,
  dateFrom?: string,
  dateTo?: string,
  meals?: string[],
  partySize?: number
): Promise<ReservationAvailability> {
  const jaUrl = toJapaneseUrl(tabelogUrl);
  const mealsKey = meals?.sort().join(',') || '';
  const dateKey = dateFrom ? `${dateFrom}-${dateTo || ''}` : '';
  const partyKey = partySize ? String(partySize) : '';
  const cacheKey = [jaUrl, dateKey, mealsKey, partyKey].filter(Boolean).join('::') || jaUrl;
  const shortUrl = jaUrl.replace('https://tabelog.com/', '').slice(0, 40);

  if (!refresh) {
    const cached = availabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      // Cache-bust: re-scrape if bookable but no date data (old scraper couldn't extract dates)
      if (cached.data.hasOnlineReservation && cached.data.dates.length === 0) {
        console.log(`  [avail] CACHE BUST ${shortUrl} (bookable but no dates)`);
      } else {
        console.log(`  [avail] CACHE HIT ${shortUrl}`);
        return cached.data;
      }
    }
  }

  const t0 = Date.now();

  // Step 1: Fast HTTP pre-check — does this restaurant have online reservations?
  const t1 = Date.now();
  const hasBooking = await quickBookingCheck(jaUrl);
  const httpMs = Date.now() - t1;

  if (!hasBooking) {
    console.log(`  [avail] ${shortUrl} HTTP=${httpMs}ms → no reservation`);
    const result: ReservationAvailability = {
      tabelogUrl: jaUrl,
      hasOnlineReservation: false,
      reservationUrl: null,
      dates: [],
      checkedAt: new Date().toISOString(),
    };
    availabilityCache.set(cacheKey, { data: result, timestamp: Date.now() });
    saveCache();
    return result;
  }

  console.log(`  [avail] ${shortUrl} HTTP=${httpMs}ms → HAS reservation, scraping dates...`);

  // Step 2: Full Playwright scrape for date availability (only for restaurants with reservations)
  const b = await getBrowser();
  const context = await b.newContext({ userAgent: UA });
  const page = await context.newPage();

  try {
    const t2 = Date.now();
    await page.goto(jaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`  [avail] ${shortUrl} goto=${Date.now() - t2}ms`);

    // Find the actual yoyaku booking page URL (skip send_remind and FAQ links)
    let reservationUrl: string | null = null;
    let bookingUrl: string | null = null;
    try {
      const yoyakuLinks = page.locator('a[href*="yoyaku.tabelog.com"]');
      const linkCount = await yoyakuLinks.count();
      for (let i = 0; i < linkCount; i++) {
        const href = await yoyakuLinks.nth(i).getAttribute('href', { timeout: 300 });
        if (href) {
          if (!reservationUrl) reservationUrl = href;
          // Find actual booking page — skip send_remind, FAQ, and other non-booking URLs
          if (!href.includes('send_remind') && !href.includes('faq') && !href.includes('cid=')) {
            bookingUrl = href;
            break;
          }
        }
      }
    } catch { /* no yoyaku links */ }

    const dates: DateAvailability[] = [];

    // Navigate to the yoyaku booking page to extract real calendar data
    if (bookingUrl) {
      const t3 = Date.now();
      try {
        await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        // Wait for calendar to render
        await page.waitForSelector('table, [class*="calendar"], [class*="rsv"]', { timeout: 5000 });
        console.log(`  [avail] ${shortUrl} yoyaku=${Date.now() - t3}ms`);

        // Extract dates from yoyaku calendar
        // Yoyaku calendars typically have cells with ◯/△/✕ and date links
        const calendarCells = page.locator('td');
        const cellCount = await calendarCells.count();

        for (let i = 0; i < Math.min(cellCount, 90); i++) {
          try {
            const cell = calendarCells.nth(i);
            const text = (await cell.textContent({ timeout: 200 }))?.trim() || '';
            const cellClass = await cell.getAttribute('class') || '';

            // Try to extract date from links in the cell
            let dateStr: string | null = null;
            try {
              const links = cell.locator('a');
              const linkCount = await links.count();
              for (let j = 0; j < linkCount; j++) {
                const href = await links.nth(j).getAttribute('href', { timeout: 200 });
                const dateMatch = href?.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
                if (dateMatch) {
                  dateStr = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
                  break;
                }
              }
            } catch { /* no date link */ }

            // Also try data attributes for date
            if (!dateStr) {
              try {
                for (const attr of ['data-date', 'data-day']) {
                  const val = await cell.getAttribute(attr, { timeout: 100 });
                  if (val) {
                    const dateMatch = val.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
                    if (dateMatch) { dateStr = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`; break; }
                  }
                }
              } catch { /* skip */ }
            }

            // Determine status
            let status: DateAvailability['status'] = 'unknown';
            if (text.includes('◯') || text.includes('○') || cellClass.includes('available') || cellClass.includes('open') || cellClass.includes('vacancy')) {
              status = 'available';
            } else if (text.includes('△') || cellClass.includes('limited') || cellClass.includes('few')) {
              status = 'limited';
            } else if (text.includes('✕') || text.includes('×') || text.includes('−') || cellClass.includes('closed') || cellClass.includes('full') || cellClass.includes('soldout') || cellClass.includes('disable')) {
              status = 'unavailable';
            }

            if (dateStr && status !== 'unknown') {
              dates.push({ date: dateStr, status, timeSlots: [] });
            }
          } catch { continue; }
        }
      } catch (err) {
        console.log(`  [avail] ${shortUrl} yoyaku failed: ${err}`);
      }
    } else {
      console.log(`  [avail] ${shortUrl} no yoyaku booking URL found (external system?)`);
    }

    const result: ReservationAvailability = {
      tabelogUrl: jaUrl,
      hasOnlineReservation: true,
      reservationUrl,
      dates,
      checkedAt: new Date().toISOString(),
    };

    console.log(`  [avail] ${shortUrl} TOTAL=${Date.now() - t0}ms dates=${dates.length}`);
    availabilityCache.set(cacheKey, { data: result, timestamp: Date.now() });
    saveCache();
    return result;
  } catch (err) {
    console.log(`  [avail] ${shortUrl} ERROR=${Date.now() - t0}ms ${err}`);
    const result: ReservationAvailability = {
      tabelogUrl: jaUrl,
      hasOnlineReservation: false,
      reservationUrl: null,
      dates: [],
      checkedAt: new Date().toISOString(),
      error: String(err),
    };
    return result;
  } finally {
    await context.close();
  }
}
