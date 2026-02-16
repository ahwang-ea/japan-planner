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
// Streams results per-date as newline-delimited JSON so the client can show progress
availabilityRouter.post('/search', async (req, res) => {
  const { city, dates, meal, partySize } = req.body;
  if (!city || !dates?.length) {
    res.status(400).json({ error: 'city and dates[] are required' });
    return;
  }

  // Set up streaming response (newline-delimited JSON)
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if proxied
  res.flushHeaders();

  // Track client disconnection via event — req.destroyed is unreliable after express.json()
  // parses the body (the request stream is consumed, so destroyed becomes true)
  let clientGone = false;
  res.on('close', () => { clientGone = true; });

  try {
    const { browseTabelog } = await import('../lib/scrapers/tabelog.js');
    // svt (time) is REQUIRED for vac_net=1 to actually filter — without it Tabelog returns all restaurants
    const time = meal === 'lunch' ? '1200' : '1900';
    const MAX_PAGES_PER_DATE = 5;
    const allRestaurants = new Map<string, Awaited<ReturnType<typeof browseTabelog>>['restaurants'][0]>();

    console.log(`[avail-search] city=${city} dates=${dates.join(',')} meal=${meal || 'any'} party=${partySize || 'any'}`);

    // Search each date in parallel, stream results as each date completes
    await Promise.all((dates as string[]).slice(0, 14).map(async (date: string) => {
      if (clientGone) return;

      const available: string[] = [];
      const dateTimeSlots: Record<string, string[]> = {};
      const dateRestaurants: Awaited<ReturnType<typeof browseTabelog>>['restaurants'][0][] = [];

      for (let p = 1; p <= MAX_PAGES_PER_DATE; p++) {
        if (clientGone) return;
        const result = await browseTabelog(city, p, false, 'rt', {
          date,
          time,
          partySize: partySize || undefined,
        });
        for (const r of result.restaurants) {
          if (r.tabelog_url) {
            available.push(r.tabelog_url);
            if (!allRestaurants.has(r.tabelog_url)) {
              allRestaurants.set(r.tabelog_url, r);
              dateRestaurants.push(r);
            }
            if (r.time_slots?.length) {
              dateTimeSlots[r.tabelog_url] = r.time_slots;
            }
          }
        }
        if (!result.hasNextPage) break;
      }

      console.log(`[avail-search]   ${date}: ${available.length} available`);

      // Stream this date's results immediately
      if (!clientGone) {
        res.write(JSON.stringify({
          type: 'date',
          date,
          available,
          restaurants: dateRestaurants,
          timeSlots: dateTimeSlots,
        }) + '\n');
      }
    }));

    console.log(`[avail-search] total unique restaurants: ${allRestaurants.size}`);
    if (!clientGone) {
      res.write(JSON.stringify({ type: 'done', totalRestaurants: allRestaurants.size }) + '\n');
    }
    res.end();
  } catch (error) {
    console.error('[avail-search] failed', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Availability search failed', details: String(error) });
    } else if (!clientGone) {
      res.write(JSON.stringify({ type: 'error', error: String(error) }) + '\n');
      res.end();
    }
  }
});

// TableAll date-range availability search
// Streams results per-date as NDJSON (same format as /search) for the client to consume
availabilityRouter.post('/search-tableall', async (req, res) => {
  const { dates, area } = req.body;
  if (!dates?.length) {
    res.status(400).json({ error: 'dates[] is required' });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientGone = false;
  res.on('close', () => { clientGone = true; });

  try {
    const { browseTableAll } = await import('../lib/scrapers/tableall.js');
    const sortedDates = (dates as string[]).slice(0, 14).sort();
    const dateFrom = sortedDates[0]!;
    const dateTo = sortedDates[sortedDates.length - 1]!;

    console.log(`[tableall-search] dates=${sortedDates.join(',')} area=${area || 'all'}`);

    const result = await browseTableAll(dateFrom, dateTo, area || undefined);

    if (clientGone) return;

    // Enrich with Tabelog ratings — check DB first, then Tabelog browse cache
    const names = result.restaurants.map(r => r.name);
    const placeholders = names.map(() => '?').join(',');
    const dbMatches = names.length > 0
      ? db.prepare(`SELECT name, tabelog_url, tabelog_score FROM restaurants WHERE name IN (${placeholders})`).all(...names) as { name: string; tabelog_url: string | null; tabelog_score: number | null }[]
      : [];
    const scoreByName = new Map<string, { tabelog_url: string | null; tabelog_score: number | null }>(
      dbMatches.map(r => [r.name, { tabelog_url: r.tabelog_url, tabelog_score: r.tabelog_score }]),
    );

    // Fallback: look up scores from Tabelog browse cache + Tabelog search
    const uncoveredNames = names.filter(n => !scoreByName.has(n));
    if (uncoveredNames.length > 0) {
      const { lookupScoresByName } = await import('../lib/scrapers/tabelog.js');
      const cacheMatches = await lookupScoresByName(uncoveredNames, (area || 'tokyo').toLowerCase());
      for (const [name, data] of cacheMatches) {
        scoreByName.set(name, data);
      }
    }

    // Build a per-date index: for each requested date, which restaurants are available?
    const allRestaurantsByUrl = new Map<string, (typeof result.restaurants)[0]>();
    for (const r of result.restaurants) {
      allRestaurantsByUrl.set(r.tableall_url, r);
    }

    // Stream results per-date (matching tabelog search format)
    const emittedUrls = new Set<string>();
    for (const date of sortedDates) {
      if (clientGone) return;

      const available: string[] = [];
      const dateRestaurants: (typeof result.restaurants)[0][] = [];

      for (const r of result.restaurants) {
        if (r.available_dates.includes(date)) {
          available.push(r.tableall_url);
          if (!emittedUrls.has(r.tableall_url)) {
            emittedUrls.add(r.tableall_url);
            dateRestaurants.push(r);
          }
        }
      }

      console.log(`[tableall-search]   ${date}: ${available.length} available`);

      res.write(JSON.stringify({
        type: 'date',
        date,
        available,
        restaurants: dateRestaurants.map(r => {
          const match = scoreByName.get(r.name);
          return {
            name: r.name,
            name_ja: null,
            tabelog_url: match?.tabelog_url || null,
            tableall_url: r.tableall_url,
            tabelog_score: match?.tabelog_score || null,
            cuisine: r.cuisine,
            area: r.area,
            city: null,
            price_range: r.price_range,
            image_url: r.image_url,
            has_online_reservation: true,
          };
        }),
        timeSlots: {},
      }) + '\n');
    }

    console.log(`[tableall-search] total restaurants: ${result.restaurants.length}`);
    if (!clientGone) {
      res.write(JSON.stringify({ type: 'done', totalRestaurants: result.restaurants.length }) + '\n');
    }
    res.end();
  } catch (error) {
    console.error('[tableall-search] failed', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'TableAll search failed', details: String(error) });
    } else if (!clientGone) {
      res.write(JSON.stringify({ type: 'error', error: String(error) }) + '\n');
      res.end();
    }
  }
});
