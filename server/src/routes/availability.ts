import { Router } from 'express';
import db from '../lib/db.js';

export const availabilityRouter = Router();

// Classify time slots into lunch vs dinner availability
function classifyMeals(timeSlots: string[]): { lunch: 'available' | 'unavailable'; dinner: 'available' | 'unavailable' } {
  let hasLunch = false, hasDinner = false;
  for (const t of timeSlots) {
    const hour = parseInt(t.split(':')[0], 10);
    if (!isNaN(hour)) { if (hour < 15) hasLunch = true; else hasDinner = true; }
  }
  return { lunch: hasLunch ? 'available' : 'unavailable', dinner: hasDinner ? 'available' : 'unavailable' };
}

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
    const { browseTabelog, getCachedPlatformLinks, discoverPlatformLinks } = await import('../lib/scrapers/tabelog.js');
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

      // Build meal availability from time slots
      const dateMealAvail: Record<string, { lunch: 'available' | 'unavailable'; dinner: 'available' | 'unavailable' }> = {};
      for (const [url, slots] of Object.entries(dateTimeSlots)) {
        if (slots.length > 0) dateMealAvail[url] = classifyMeals(slots);
      }

      // Stream this date's results immediately, enriched with cached platform links
      if (!clientGone) {
        res.write(JSON.stringify({
          type: 'date',
          date,
          available,
          restaurants: dateRestaurants.map(r => {
            const cached = r.name ? getCachedPlatformLinks(r.name, city, r.area) : null;
            return cached ? { ...r, ...cached } : r;
          }),
          timeSlots: dateTimeSlots,
          mealAvailability: dateMealAvail,
        }) + '\n');
      }
    }));

    console.log(`[avail-search] total unique restaurants: ${allRestaurants.size}`);
    if (!clientGone) {
      res.write(JSON.stringify({ type: 'done', totalRestaurants: allRestaurants.size }) + '\n');
    }

    // Background: discover platform links for high-rated restaurants without cached links
    const toDiscover = [...allRestaurants.values()]
      .filter(r => r.name && (r.tabelog_score ?? 0) >= 3.7 && !getCachedPlatformLinks(r.name, city, r.area));

    if (toDiscover.length > 0 && !clientGone) {
      console.log(`[avail-search] discovering platform links for ${toDiscover.length} restaurants (3.7+)`);
      const DISCOVER_CONCURRENCY = 3;
      for (let i = 0; i < toDiscover.length && !clientGone; i += DISCOVER_CONCURRENCY) {
        const batch = toDiscover.slice(i, i + DISCOVER_CONCURRENCY);
        const results = await Promise.all(batch.map(async r => {
          const links = await discoverPlatformLinks(r.name!, city, r.area, r.address, r.phone, r.tabelog_url);
          return { tabelog_url: r.tabelog_url, name: r.name, ...links };
        }));
        // Stream discovered links to client
        const withLinks = results.filter(r => r.tablecheck_url || r.omakase_url || r.tableall_url);
        if (withLinks.length > 0 && !clientGone) {
          res.write(JSON.stringify({ type: 'platform-update', restaurants: withLinks }) + '\n');
        }
      }
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
    const { lookupScoresByName, getCachedPlatformLinks, discoverPlatformLinks } = await import('../lib/scrapers/tabelog.js');
    const sortedDates = (dates as string[]).slice(0, 14).sort();
    const dateFrom = sortedDates[0]!;
    const dateTo = sortedDates[sortedDates.length - 1]!;
    const cityKey = (area || 'tokyo').toLowerCase();

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
      const cacheMatches = await lookupScoresByName(uncoveredNames, cityKey);
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
          const cached = getCachedPlatformLinks(r.name, cityKey, r.area);
          return {
            name: r.name,
            name_ja: null,
            tabelog_url: match?.tabelog_url || null,
            tableall_url: r.tableall_url,
            tablecheck_url: cached?.tablecheck_url || null,
            omakase_url: cached?.omakase_url || null,
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

    // Background: discover platform links for restaurants without cached links
    const toDiscover = result.restaurants
      .filter(r => r.name && !getCachedPlatformLinks(r.name, cityKey, r.area));
    if (toDiscover.length > 0 && !clientGone) {
      console.log(`[tableall-search] discovering platform links for ${toDiscover.length} restaurants`);
      const DISCOVER_CONCURRENCY = 3;
      for (let i = 0; i < toDiscover.length && !clientGone; i += DISCOVER_CONCURRENCY) {
        const batch = toDiscover.slice(i, i + DISCOVER_CONCURRENCY);
        const results = await Promise.all(batch.map(async r => {
          const links = await discoverPlatformLinks(r.name, cityKey, r.area);
          const match = scoreByName.get(r.name);
          return { ...links, tabelog_url: match?.tabelog_url || null, name: r.name, tableall_url: r.tableall_url };
        }));
        const withLinks = results.filter(r => r.tablecheck_url || r.omakase_url);
        if (withLinks.length > 0 && !clientGone) {
          res.write(JSON.stringify({ type: 'platform-update', restaurants: withLinks }) + '\n');
        }
      }
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

// TableCheck date-range availability search
// Streams results per-date as NDJSON (same format as /search) for the client to consume
availabilityRouter.post('/search-tablecheck', async (req, res) => {
  const { dates, city, partySize, meal } = req.body;
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
    const { browseTableCheck } = await import('../lib/scrapers/tablecheck.js');
    const { lookupScoresByName, getCachedPlatformLinks, discoverPlatformLinks } = await import('../lib/scrapers/tabelog.js');
    const sortedDates = (dates as string[]).slice(0, 14).sort();
    const dateFrom = sortedDates[0]!;
    const dateTo = sortedDates[sortedDates.length - 1]!;
    const cityKey = (city || 'tokyo').toLowerCase();

    console.log(`[tablecheck-search] dates=${sortedDates.join(',')} city=${cityKey} party=${partySize || 2} meal=${meal || 'any'}`);

    const result = await browseTableCheck(dateFrom, dateTo, cityKey, partySize || 2, meal || undefined);

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

    console.log(`[tablecheck-search] enrichment: ${names.length} restaurants, ${dbMatches.length} DB matches, SERPER_API_KEY=${process.env.SERPER_API_KEY ? 'set' : 'NOT SET'}`);

    const uncoveredNames = names.filter(n => !scoreByName.has(n));
    if (uncoveredNames.length > 0) {
      console.log(`[tablecheck-search] looking up ${uncoveredNames.length} names via Tabelog cache/Serper: ${uncoveredNames.slice(0, 5).join(', ')}${uncoveredNames.length > 5 ? '...' : ''}`);
      const cacheMatches = await lookupScoresByName(uncoveredNames, cityKey);
      for (const [name, data] of cacheMatches) {
        scoreByName.set(name, data);
      }
      const withScores = [...cacheMatches.values()].filter(d => d.tabelog_score !== null).length;
      console.log(`[tablecheck-search] lookup results: ${cacheMatches.size} matched, ${withScores} with scores`);
    }

    // Stream results per-date (matching tabelog search format)
    const emittedUrls = new Set<string>();
    for (const date of sortedDates) {
      if (clientGone) return;

      const available: string[] = [];
      const dateRestaurants: (typeof result.restaurants)[0][] = [];
      const dateTimeSlots: Record<string, string[]> = {};

      for (const r of result.restaurants) {
        if (r.available_dates.includes(date)) {
          available.push(r.tablecheck_url);
          if (!emittedUrls.has(r.tablecheck_url)) {
            emittedUrls.add(r.tablecheck_url);
            dateRestaurants.push(r);
          }
          if (r.time_slots[date]?.length) {
            dateTimeSlots[r.tablecheck_url] = r.time_slots[date]!;
          }
        }
      }

      // Build meal availability from time slots
      const dateMealAvail: Record<string, { lunch: 'available' | 'unavailable'; dinner: 'available' | 'unavailable' }> = {};
      for (const [url, slots] of Object.entries(dateTimeSlots)) {
        if (slots.length > 0) dateMealAvail[url] = classifyMeals(slots);
      }

      console.log(`[tablecheck-search]   ${date}: ${available.length} available`);

      res.write(JSON.stringify({
        type: 'date',
        date,
        available,
        restaurants: dateRestaurants.map(r => {
          const match = scoreByName.get(r.name);
          const cached = getCachedPlatformLinks(r.name, cityKey);
          return {
            name: r.name,
            name_ja: null,
            tabelog_url: match?.tabelog_url || null,
            tablecheck_url: r.tablecheck_url,
            tableall_url: cached?.tableall_url || null,
            omakase_url: cached?.omakase_url || null,
            tabelog_score: match?.tabelog_score || null,
            cuisine: r.cuisine,
            area: null,
            city: null,
            price_range: r.price_range,
            image_url: r.image_url,
            has_online_reservation: true,
          };
        }),
        timeSlots: dateTimeSlots,
        mealAvailability: dateMealAvail,
      }) + '\n');
    }

    console.log(`[tablecheck-search] total restaurants: ${result.restaurants.length}`);
    if (!clientGone) {
      res.write(JSON.stringify({ type: 'done', totalRestaurants: result.restaurants.length }) + '\n');
    }

    // Background: discover platform links for restaurants without cached links
    const toDiscover = result.restaurants
      .filter(r => r.name && !getCachedPlatformLinks(r.name, cityKey));
    if (toDiscover.length > 0 && !clientGone) {
      console.log(`[tablecheck-search] discovering platform links for ${toDiscover.length} restaurants`);
      const DISCOVER_CONCURRENCY = 3;
      for (let i = 0; i < toDiscover.length && !clientGone; i += DISCOVER_CONCURRENCY) {
        const batch = toDiscover.slice(i, i + DISCOVER_CONCURRENCY);
        const results = await Promise.all(batch.map(async r => {
          // TableCheck results don't have area/address — fall back to city-level search
          const links = await discoverPlatformLinks(r.name, cityKey);
          const match = scoreByName.get(r.name);
          return { ...links, tabelog_url: match?.tabelog_url || null, name: r.name, tablecheck_url: r.tablecheck_url };
        }));
        const withLinks = results.filter(r => r.tableall_url || r.omakase_url);
        if (withLinks.length > 0 && !clientGone) {
          res.write(JSON.stringify({ type: 'platform-update', restaurants: withLinks }) + '\n');
        }
      }
    }

    res.end();
  } catch (error) {
    console.error('[tablecheck-search] failed', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'TableCheck search failed', details: String(error) });
    } else if (!clientGone) {
      res.write(JSON.stringify({ type: 'error', error: String(error) }) + '\n');
      res.end();
    }
  }
});

// On-demand platform link discovery for a saved restaurant
availabilityRouter.post('/discover-platforms/:id', async (req, res) => {
  const { id } = req.params;
  const restaurant = db.prepare('SELECT id, name, city, area, address, phone, tabelog_url, tablecheck_url, omakase_url, tableall_url FROM restaurants WHERE id = ?').get(id) as {
    id: string; name: string; city: string | null; area: string | null; address: string | null; phone: string | null;
    tabelog_url: string | null; tablecheck_url: string | null; omakase_url: string | null; tableall_url: string | null;
  } | undefined;

  if (!restaurant) {
    res.status(404).json({ error: 'Restaurant not found' });
    return;
  }

  try {
    const { discoverPlatformLinks } = await import('../lib/scrapers/tabelog.js');
    const links = await discoverPlatformLinks(restaurant.name, restaurant.city || 'tokyo', restaurant.area, restaurant.address, restaurant.phone, restaurant.tabelog_url);

    // Update DB — only fill in missing URLs (don't overwrite existing)
    db.prepare(
      `UPDATE restaurants SET
        tablecheck_url = COALESCE(tablecheck_url, ?),
        omakase_url = COALESCE(omakase_url, ?),
        tableall_url = COALESCE(tableall_url, ?)
      WHERE id = ?`
    ).run(links.tablecheck_url, links.omakase_url, links.tableall_url, id);

    res.json({
      tablecheck_url: restaurant.tablecheck_url || links.tablecheck_url,
      omakase_url: restaurant.omakase_url || links.omakase_url,
      tableall_url: restaurant.tableall_url || links.tableall_url,
    });
  } catch (error) {
    res.status(500).json({ error: 'Platform discovery failed', details: String(error) });
  }
});

// Name-based platform discovery — streams NDJSON progress for each restaurant
availabilityRouter.post('/discover-platforms', async (req, res) => {
  const { names, city, restaurants: restaurantMeta } = req.body as {
    names: string[];
    city?: string;
    restaurants?: Record<string, { area?: string; address?: string; tabelogUrl?: string }>;
  };
  if (!names?.length) {
    res.status(400).json({ error: 'names[] is required' });
    return;
  }

  // Stream NDJSON so the client gets real-time progress
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientGone = false;
  res.on('close', () => { clientGone = true; });

  const total = names.length;
  let completed = 0;
  let found = 0;

  // Look up phone numbers from DB for restaurants that have been saved
  const phoneLookup = new Map<string, string>();
  if (names.length > 0) {
    const placeholders = names.map(() => '?').join(',');
    const rows = db.prepare(`SELECT name, phone FROM restaurants WHERE name IN (${placeholders}) AND phone IS NOT NULL`).all(...names) as { name: string; phone: string }[];
    for (const r of rows) phoneLookup.set(r.name, r.phone);
  }

  console.log(`[discover-platforms] START — ${total} restaurants, city=${city || 'tokyo'}, with area data: ${restaurantMeta ? Object.keys(restaurantMeta).length : 0}, phone from DB: ${phoneLookup.size}`);

  try {
    const { discoverPlatformLinks } = await import('../lib/scrapers/tabelog.js');
    const cityKey = (city || 'tokyo').toLowerCase();
    const BATCH_SIZE = 3;

    for (let i = 0; i < names.length && !clientGone; i += BATCH_SIZE) {
      const batch = names.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (name) => {
        if (clientGone) return;

        // Stream progress before starting
        if (!clientGone) {
          res.write(JSON.stringify({ type: 'progress', current: completed + 1, total, name }) + '\n');
        }

        const meta = restaurantMeta?.[name];
        const phone = phoneLookup.get(name) || null;
        const links = await discoverPlatformLinks(name, cityKey, meta?.area, meta?.address, phone, meta?.tabelogUrl);
        completed++;

        const hasLinks = !!(links.tablecheck_url || links.omakase_url || links.tableall_url);
        if (hasLinks) found++;

        console.log(`[discover-platforms] (${completed}/${total}) "${name}" → TC=${links.tablecheck_url ? 'yes' : 'no'} OM=${links.omakase_url ? 'yes' : 'no'} TA=${links.tableall_url ? 'yes' : 'no'}`);

        // Stream result for this restaurant
        if (!clientGone) {
          res.write(JSON.stringify({ type: 'result', name, links }) + '\n');
        }
      }));
    }

    console.log(`[discover-platforms] DONE — ${completed}/${total} checked, ${found} with platform links`);
    if (!clientGone) {
      res.write(JSON.stringify({ type: 'done', total: completed, found }) + '\n');
    }
    res.end();
  } catch (error) {
    console.error('[discover-platforms] FAIL', error);
    if (!clientGone) {
      res.write(JSON.stringify({ type: 'error', error: String(error) }) + '\n');
      res.end();
    }
  }
});

// Omakase.in Premium date-range availability search
// Streams results per-date as NDJSON (same format as /search) for the client to consume
availabilityRouter.post('/search-omakase', async (req, res) => {
  const { dates, city, guestsCount } = req.body;
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
    const { browseOmakase, AREA_IDS } = await import('../lib/scrapers/omakase.js');
    const { lookupScoresByName, getCachedPlatformLinks, discoverPlatformLinks } = await import('../lib/scrapers/tabelog.js');
    const sortedDates = (dates as string[]).slice(0, 14).sort();
    const dateFrom = sortedDates[0]!;
    const dateTo = sortedDates[sortedDates.length - 1]!;
    const cityKey = (city || 'tokyo').toLowerCase();
    const areaId = AREA_IDS[cityKey] || 171;

    console.log(`[omakase-search] dates=${sortedDates.join(',')} city=${cityKey} area_id=${areaId} guests=${guestsCount || 2}`);

    // Stream a progress event immediately so the client knows something is happening
    res.write(JSON.stringify({ type: 'progress', message: 'Connecting to omakase.in...' }) + '\n');

    // Track all restaurants and scores for final enrichment
    const scoreByName = new Map<string, { tabelog_url: string | null; tabelog_score: number | null }>();
    const emittedUrls = new Set<string>();
    const allRestaurantsForDiscovery: { name: string; omakase_url: string; area: string | null }[] = [];

    // Stream results page-by-page as the scraper yields them
    const result = await browseOmakase(dateFrom, dateTo, areaId, guestsCount || 2, false, (pageRestaurants, pageNum, hasMore) => {
      if (clientGone || pageRestaurants.length === 0) return;

      // Enrich with Tabelog ratings from DB
      const names = pageRestaurants.map(r => r.name);
      const placeholders = names.map(() => '?').join(',');
      const dbMatches = names.length > 0
        ? db.prepare(`SELECT name, tabelog_url, tabelog_score FROM restaurants WHERE name IN (${placeholders})`).all(...names) as { name: string; tabelog_url: string | null; tabelog_score: number | null }[]
        : [];
      for (const m of dbMatches) scoreByName.set(m.name, { tabelog_url: m.tabelog_url, tabelog_score: m.tabelog_score });

      // Stream per-date availability for this page's restaurants
      for (const date of sortedDates) {
        if (clientGone) return;

        const available: string[] = [];
        const dateRestaurants: typeof pageRestaurants = [];

        for (const r of pageRestaurants) {
          if (r.available_dates.includes(date)) {
            available.push(r.omakase_url);
            if (!emittedUrls.has(r.omakase_url)) {
              emittedUrls.add(r.omakase_url);
              dateRestaurants.push(r);
              allRestaurantsForDiscovery.push({ name: r.name, omakase_url: r.omakase_url, area: r.area });
            }
          }
        }

        if (available.length === 0 && dateRestaurants.length === 0) continue;

        // Build meal availability from omakase's available_meals data
        const dateMealAvail: Record<string, { lunch: 'available' | 'unavailable'; dinner: 'available' | 'unavailable' }> = {};
        for (const r of pageRestaurants) {
          if (r.available_dates.includes(date)) {
            const meals = r.available_meals[date];
            dateMealAvail[r.omakase_url] = {
              lunch: meals?.includes('lunch') ? 'available' : 'unavailable',
              dinner: meals?.includes('dinner') ? 'available' : 'unavailable',
            };
          }
        }

        console.log(`[omakase-search] p${pageNum} ${date}: ${available.length} available`);

        res.write(JSON.stringify({
          type: 'date',
          date,
          available,
          restaurants: dateRestaurants.map(r => {
            const match = scoreByName.get(r.name);
            const cached = getCachedPlatformLinks(r.name, cityKey, r.area);
            return {
              name: r.name,
              name_ja: null,
              tabelog_url: match?.tabelog_url || null,
              tableall_url: cached?.tableall_url || null,
              tablecheck_url: cached?.tablecheck_url || null,
              omakase_url: r.omakase_url,
              tabelog_score: match?.tabelog_score || null,
              cuisine: r.cuisine,
              area: r.area,
              city: null,
              price_range: null,
              image_url: r.image_url,
              has_online_reservation: true,
            };
          }),
          timeSlots: {},
          mealAvailability: dateMealAvail,
        }) + '\n');
      }

      if (!clientGone) {
        res.write(JSON.stringify({ type: 'progress', message: `Page ${pageNum} scraped (${pageRestaurants.length} restaurants)${hasMore ? ', loading more...' : ''}` }) + '\n');
      }
    });

    console.log(`[omakase-search] total restaurants: ${result.restaurants.length}`);

    // Enrich uncovered names with Tabelog cache/search
    const uncoveredNames = result.restaurants.map(r => r.name).filter(n => !scoreByName.has(n));
    if (uncoveredNames.length > 0) {
      const cacheMatches = await lookupScoresByName(uncoveredNames, cityKey);
      for (const [name, data] of cacheMatches) scoreByName.set(name, data);
      // Stream score updates to client
      const scoreUpdates = [...cacheMatches.entries()]
        .filter(([, d]) => d.tabelog_score)
        .map(([name, d]) => ({ name, tabelog_url: d.tabelog_url, tabelog_score: d.tabelog_score }));
      if (scoreUpdates.length > 0 && !clientGone) {
        res.write(JSON.stringify({ type: 'platform-update', restaurants: scoreUpdates }) + '\n');
      }
    }

    if (!clientGone) {
      res.write(JSON.stringify({ type: 'done', totalRestaurants: result.restaurants.length }) + '\n');
    }

    // Background: discover platform links for restaurants without cached links
    const toDiscover = allRestaurantsForDiscovery
      .filter(r => r.name && !getCachedPlatformLinks(r.name, cityKey, r.area));
    if (toDiscover.length > 0 && !clientGone) {
      console.log(`[omakase-search] discovering platform links for ${toDiscover.length} restaurants`);
      const DISCOVER_CONCURRENCY = 3;
      for (let i = 0; i < toDiscover.length && !clientGone; i += DISCOVER_CONCURRENCY) {
        const batch = toDiscover.slice(i, i + DISCOVER_CONCURRENCY);
        const results = await Promise.all(batch.map(async r => {
          const links = await discoverPlatformLinks(r.name, cityKey, r.area);
          const match = scoreByName.get(r.name);
          return { ...links, tabelog_url: match?.tabelog_url || null, name: r.name, omakase_url: r.omakase_url };
        }));
        const withLinks = results.filter(r => r.tablecheck_url || r.tableall_url);
        if (withLinks.length > 0 && !clientGone) {
          res.write(JSON.stringify({ type: 'platform-update', restaurants: withLinks }) + '\n');
        }
      }
    }

    res.end();
  } catch (error) {
    console.error('[omakase-search] failed', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Omakase search failed', details: String(error) });
    } else if (!clientGone) {
      res.write(JSON.stringify({ type: 'error', error: String(error) }) + '\n');
      res.end();
    }
  }
});
