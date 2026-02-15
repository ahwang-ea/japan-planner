import { Router } from 'express';
import db from '../lib/db.js';

export const availabilityRouter = Router();

// Get availability results for a restaurant + trip
availabilityRouter.get('/', (req, res) => {
  const { restaurant_id, trip_id } = req.query;

  let query = 'SELECT * FROM availability_results WHERE 1=1';
  const params: unknown[] = [];

  if (restaurant_id) {
    query += ' AND restaurant_id = ?';
    params.push(restaurant_id);
  }
  if (trip_id) {
    query += ' AND trip_id = ?';
    params.push(trip_id);
  }

  query += ' ORDER BY check_date ASC, platform ASC';

  const results = db.prepare(query).all(...params);
  res.json(results);
});

// Check reservation availability for a restaurant URL (no DB save needed)
availabilityRouter.post('/check', async (req, res) => {
  const { tabelog_url, dateFrom, dateTo, meals, partySize } = req.body;
  if (!tabelog_url || !tabelog_url.includes('tabelog.com')) {
    res.status(400).json({ error: 'Valid Tabelog URL is required' });
    return;
  }

  const start = Date.now();
  const shortUrl = tabelog_url.replace('https://tabelog.com/', '').slice(0, 50);
  const mealsArr: string[] | undefined = Array.isArray(meals) ? meals : undefined;
  const party: number | undefined = typeof partySize === 'number' && partySize > 0 ? partySize : undefined;
  console.log(`[avail] START ${shortUrl}${dateFrom ? ` from=${dateFrom}` : ''}${dateTo ? ` to=${dateTo}` : ''}${mealsArr ? ` meals=${mealsArr.join(',')}` : ''}${party ? ` party=${party}` : ''}`);
  try {
    const { scrapeReservationAvailability } = await import('../lib/scrapers/tabelog-availability.js');
    const result = await scrapeReservationAvailability(tabelog_url, false, dateFrom, dateTo, mealsArr, party);
    const ms = Date.now() - start;
    console.log(`[avail] DONE  ${shortUrl} — ${ms}ms | online=${result.hasOnlineReservation} dates=${result.dates.length}${result.error ? ' ERR=' + result.error : ''}`);
    res.json(result);
  } catch (error) {
    console.log(`[avail] FAIL  ${shortUrl} — ${Date.now() - start}ms | ${error}`);
    res.status(500).json({ error: 'Failed to check availability', details: String(error) });
  }
});

// Batch check availability for multiple URLs
availabilityRouter.post('/check-batch', async (req, res) => {
  const { urls } = req.body as { urls: string[] };
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'Array of Tabelog URLs is required' });
    return;
  }

  try {
    const { scrapeReservationAvailability } = await import('../lib/scrapers/tabelog-availability.js');
    const results: Record<string, Awaited<ReturnType<typeof scrapeReservationAvailability>>> = {};

    // Check sequentially with delays to avoid rate limiting
    for (const url of urls) {
      if (!url.includes('tabelog.com')) continue;
      try {
        results[url] = await scrapeReservationAvailability(url);
      } catch {
        results[url] = {
          tabelogUrl: url,
          hasOnlineReservation: false,
          reservationUrl: null,
          dates: [],
          checkedAt: new Date().toISOString(),
          error: 'Failed to check',
        };
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Failed to check availability', details: String(error) });
  }
});

// Batch availability search using Tabelog's native date filtering
// Instead of checking each restaurant individually, search Tabelog with date params
// and return which restaurant URLs are available per date
availabilityRouter.post('/search', async (req, res) => {
  const { city, dates, meal, partySize } = req.body;
  if (!city || !dates?.length) {
    res.status(400).json({ error: 'city and dates[] are required' });
    return;
  }

  try {
    const { browseTabelog } = await import('../lib/scrapers/tabelog.js');
    // svt (time) is REQUIRED for vac_net=1 to actually filter — without it Tabelog returns all restaurants
    const time = meal === 'lunch' ? '1200' : '1900';
    const MAX_PAGES_PER_DATE = 5;

    console.log(`[avail-search] city=${city} dates=${dates.join(',')} meal=${meal || 'any'} party=${partySize || 'any'}`);

    // Search each date in parallel, pages sequential per date
    // Collect unique restaurants across all dates for merging into browse list
    const availableByDate: Record<string, string[]> = {};
    const allRestaurants = new Map<string, Awaited<ReturnType<typeof browseTabelog>>['restaurants'][0]>();
    // Time slots per restaurant per date (url → { date → string[] })
    const timeSlotsMap: Record<string, Record<string, string[]>> = {};

    await Promise.all((dates as string[]).slice(0, 14).map(async (date: string) => {
      const available: string[] = [];
      for (let p = 1; p <= MAX_PAGES_PER_DATE; p++) {
        const result = await browseTabelog(city, p, false, 'rt', {
          date,
          time,
          partySize: partySize || undefined,
        });
        for (const r of result.restaurants) {
          if (r.tabelog_url) {
            available.push(r.tabelog_url);
            if (!allRestaurants.has(r.tabelog_url)) allRestaurants.set(r.tabelog_url, r);
            if (r.time_slots?.length) {
              if (!timeSlotsMap[r.tabelog_url]) timeSlotsMap[r.tabelog_url] = {};
              timeSlotsMap[r.tabelog_url][date] = r.time_slots;
            }
          }
        }
        if (!result.hasNextPage) break;
      }
      availableByDate[date] = available;
      console.log(`[avail-search]   ${date}: ${available.length} available`);
    }));

    console.log(`[avail-search] total unique restaurants: ${allRestaurants.size}`);
    res.json({ availableByDate, restaurants: Array.from(allRestaurants.values()), timeSlots: timeSlotsMap });
  } catch (error) {
    console.error('[avail-search] failed', error);
    res.status(500).json({ error: 'Availability search failed', details: String(error) });
  }
});
