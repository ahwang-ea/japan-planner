import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { isInputFocused } from '../lib/keyboard';
import RestaurantForm from '../components/RestaurantForm';
import RestaurantDetailPanel from '../components/RestaurantDetailPanel';
import AddToTripModal from '../components/AddToTripModal';
import SmartDateInput from '../components/SmartDateInput';
import { CITIES } from '../lib/constants';

export interface Restaurant {
  id: string;
  name: string;
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
  notes: string | null;
  rank: number | null;
  omakase_url: string | null;
  tablecheck_url: string | null;
  tableall_url: string | null;
  image_url: string | null;
  is_favorite: number;
  created_at: string;
  updated_at: string;
}

export interface TabelogResult {
  name: string | null;
  name_ja: string | null;
  tabelog_url: string | null;
  tabelog_score: number | null;
  cuisine: string | null;
  area: string | null;
  city: string | null;
  price_range: string | null;
  image_url: string | null;
  has_online_reservation?: boolean;
  reservation_url?: string | null;
}

interface ReservationAvailability {
  tabelogUrl: string;
  hasOnlineReservation: boolean;
  reservationUrl: string | null;
  dates: { date: string; status: 'available' | 'limited' | 'unavailable' | 'unknown'; timeSlots: string[] }[];
  checkedAt: string;
  error?: string;
}

interface BrowseResponse {
  restaurants: TabelogResult[];
  page: number;
  hasNextPage: boolean;
  dateFiltered?: boolean;
  filteredDate?: string;
}

type Tab = 'saved' | 'browse';


export default function Restaurants() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('browse');
  const [selectedRowIndex, setSelectedRowIndex] = useState(0);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);

  // Saved restaurants state
  const [saved, setSaved] = useState<Restaurant[]>([]);
  const [savedLoading, setSavedLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Browse state
  const [city, setCity] = useState('tokyo');
  const [browsePage, setBrowsePage] = useState(1);
  const [browseResults, setBrowseResults] = useState<TabelogResult[]>([]); // current page (no filter mode)
  const [allResults, setAllResults] = useState<TabelogResult[]>([]); // accumulated across pages (filter mode)
  const [lastFetchedPage, setLastFetchedPage] = useState(0);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [savedUrls, setSavedUrls] = useState<Set<string>>(new Set());
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [selectedCuisines, setSelectedCuisines] = useState<Set<string>>(new Set());
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [favoriteUrls, setFavoriteUrls] = useState<Set<string>>(new Set());
  const [animatingFavorite, setAnimatingFavorite] = useState<string | null>(null);
  const [showTripModal, setShowTripModal] = useState(false);
  const [showBookableOnly, setShowBookableOnly] = useState(false);
  const [showSpotsOpenOnly, setShowSpotsOpenOnly] = useState(false);
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [filterMeals, setFilterMeals] = useState<Set<'lunch' | 'dinner'>>(new Set());
  const [filterPartySize, setFilterPartySize] = useState(2);
  const [trips, setTrips] = useState<{ id: string; name: string; city: string | null; start_date: string; end_date: string }[]>([]);
  const [availabilityMap, setAvailabilityMap] = useState<Map<string, ReservationAvailability>>(new Map());
  const [availChecking, setAvailChecking] = useState(false);
  const [broadSearch, setBroadSearch] = useState(false);
  const [broadSearchPage, setBroadSearchPage] = useState(0);
  const [broadHasNext, setBroadHasNext] = useState(true);
  const fetchingMoreRef = useRef(false);
  const availQueueRef = useRef<string[]>([]);
  const availQueuedSetRef = useRef<Set<string>>(new Set());
  const availProcessingRef = useRef(false);

  const MIN_FILTERED = 20;
  const MAX_PAGES = 10; // safety limit per sort mode

  // Normalize Tabelog URLs — strip /en/ so Japanese and English URLs match
  const normalizeUrl = (url: string) => url.replace('tabelog.com/en/', 'tabelog.com/');

  const toggleMeal = (m: 'lunch' | 'dinner') => {
    setFilterMeals(prev => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  };

  // Generate array of YYYY-MM-DD strings for a date range (inclusive, max 14 days)
  const getDateRange = (from: string, to: string): string[] => {
    if (!from || !to) return [];
    const dates: string[] = [];
    const start = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
    const cur = new Date(start);
    while (cur <= end && dates.length < 14) {
      dates.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  };

  const dateRange = getDateRange(filterDateFrom, filterDateTo);
  const hasDateRange = dateRange.length > 0;

  // When booking filter + dates are active, use Tabelog's native date filtering
  const effectiveDateFilter = useMemo(() => {
    if (!(showBookableOnly || showSpotsOpenOnly) || !filterDateFrom) return null;
    const svt = filterMeals.size === 1
      ? (filterMeals.has('lunch') ? '1200' : '1900')
      : undefined;
    return {
      svd: filterDateFrom.replace(/-/g, ''),
      svt,
      svps: filterPartySize > 0 ? filterPartySize : undefined,
    };
  }, [showBookableOnly, showSpotsOpenOnly, filterDateFrom, filterMeals, filterPartySize]);

  const effectiveDateFilterKey = effectiveDateFilter
    ? `${effectiveDateFilter.svd}:${filterDateTo || ''}:${effectiveDateFilter.svt || ''}:${effectiveDateFilter.svps || ''}`
    : '';
  const dateFilterBrowsedRef = useRef(effectiveDateFilterKey);

  // Get the best reserve link for a restaurant — prefer the Japanese restaurant page
  // (which has the embedded booking calendar) over scraped yoyaku URLs that may be broken
  const getReserveUrl = (avail: ReservationAvailability | undefined, fallbackUrl: string | null) => {
    // Japanese restaurant page is the most reliable — booking calendar is right there
    return avail?.tabelogUrl || fallbackUrl?.replace('tabelog.com/en/', 'tabelog.com/') || fallbackUrl || '#';
  };

  const loadSaved = () => {
    setSavedLoading(true);
    api<Restaurant[]>('/restaurants').then(r => {
      setSaved(r);
      setSavedUrls(new Set(r.map(x => x.tabelog_url ? normalizeUrl(x.tabelog_url) : '').filter(Boolean)));
      setFavoriteUrls(new Set(r.filter(x => x.is_favorite).map(x => x.tabelog_url ? normalizeUrl(x.tabelog_url) : '').filter(Boolean)));
    }).finally(() => setSavedLoading(false));
  };

  useEffect(() => {
    loadSaved();
    api<typeof trips>('/trips').then(setTrips).catch(() => {});
  }, []);

  // Handle URL params from command palette
  useEffect(() => {
    if (searchParams.get('action') === 'add') {
      setTab('saved');
      setShowForm(true);
      setEditingId(null);
      setSearchParams({}, { replace: true });
    }
    if (searchParams.get('filter') === 'favorites') {
      setTab('saved');
      setShowFavoritesOnly(true);
      setSearchParams({}, { replace: true });
    }
    if (searchParams.get('tab') === 'browse') {
      setTab('browse');
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const browse = (c: string, p: number) => {
    setBrowseLoading(true);
    setBrowseResults([]);
    setAllResults([]);
    setLastFetchedPage(0);
    api<BrowseResponse>(`/restaurants/browse?city=${c}&page=${p}`)
      .then(r => {
        setBrowseResults(r.restaurants);
        setAllResults(r.restaurants);
        setHasNextPage(r.hasNextPage);
        setBrowsePage(r.page);
        setLastFetchedPage(r.page);
      })
      .catch(() => { setBrowseResults([]); setAllResults([]); })
      .finally(() => setBrowseLoading(false));
  };

  const fetchMorePages = useCallback(async () => {
    if (fetchingMoreRef.current) return;

    // Determine which mode to fetch in
    const useBroad = broadSearch;
    const currentHasNext = useBroad ? broadHasNext : hasNextPage;
    const currentPage = useBroad ? broadSearchPage : lastFetchedPage;

    if (!currentHasNext || currentPage >= MAX_PAGES) return;

    fetchingMoreRef.current = true;
    setFetchingMore(true);
    try {
      const nextPage = currentPage + 1;
      const sort = useBroad ? 'default' : 'rt';
      const r = await api<BrowseResponse>(`/restaurants/browse?city=${city}&page=${nextPage}&sort=${sort}`);
      // Dedup against already-fetched restaurants
      setAllResults(prev => {
        const existingUrls = new Set(prev.map(x => x.tabelog_url).filter(Boolean));
        const newResults = r.restaurants.filter(x => !x.tabelog_url || !existingUrls.has(x.tabelog_url));
        return [...prev, ...newResults];
      });
      if (useBroad) {
        setBroadHasNext(r.hasNextPage);
        setBroadSearchPage(nextPage);
      } else {
        setHasNextPage(r.hasNextPage);
        setLastFetchedPage(r.page);
      }
    } finally {
      fetchingMoreRef.current = false;
      setFetchingMore(false);
    }
  }, [hasNextPage, lastFetchedPage, city, broadSearch, broadHasNext, broadSearchPage]);

  const handleCityChange = (c: string) => {
    setCity(c);
    setBrowsePage(1);
    setSelectedCuisines(new Set());
    setShowBookableOnly(false);
    setShowSpotsOpenOnly(false);
    // Keep date range and meals — user may be checking same trip dates across cities
    setAvailabilityMap(new Map());
    setBroadSearch(false);
    setBroadSearchPage(0);
    setBroadHasNext(true);
    browse(c, 1);
  };

  // Navigate pages (no-filter mode): fetch a single page, but also keep it in allResults
  const goToPage = (p: number) => {
    setBrowseLoading(true);
    api<BrowseResponse>(`/restaurants/browse?city=${city}&page=${p}`)
      .then(r => {
        setBrowseResults(r.restaurants);
        setHasNextPage(r.hasNextPage);
        setBrowsePage(r.page);
        // Accumulate for when filters get toggled on later
        if (r.page > lastFetchedPage) {
          setAllResults(prev => [...prev, ...r.restaurants]);
          setLastFetchedPage(r.page);
        }
      })
      .catch(() => setBrowseResults([]))
      .finally(() => setBrowseLoading(false));
  };

  const isFiltering = selectedCuisines.size > 0 || showBookableOnly || showSpotsOpenOnly;

  // Collect unique cuisines from ALL fetched results
  const availableCuisines = [...new Set(
    allResults.flatMap(r => r.cuisine ? r.cuisine.split(',').map(c => c.trim()) : []).filter(Boolean)
  )].sort();

  const toggleCuisine = (c: string) => {
    setSelectedCuisines(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const matchesCuisine = (r: TabelogResult) => {
    if (!r.cuisine) return false;
    const parts = r.cuisine.split(',').map(c => c.trim());
    return parts.some(p => selectedCuisines.has(p));
  };

  const getAvail = (r: TabelogResult) => r.tabelog_url ? availabilityMap.get(r.tabelog_url) : undefined;

  const getNearestAvailDate = (r: TabelogResult) => {
    const avail = getAvail(r);
    if (!avail?.dates.length) return null;
    const open = avail.dates
      .filter(d => d.status === 'available' || d.status === 'limited')
      .sort((a, b) => a.date.localeCompare(b.date));
    return open[0] ?? null;
  };

  // When filtering: show matches from all accumulated results; otherwise show current page
  const filteredResults = isFiltering
    ? allResults.filter(r => {
        if (selectedCuisines.size > 0 && !matchesCuisine(r)) return false;
        if (showBookableOnly) {
          // Use inline data from browse (instant — no separate check needed)
          if (!r.has_online_reservation) return false;
        }
        if (showSpotsOpenOnly) {
          const avail = getAvail(r);
          if (!avail) return false; // not checked yet — hide until checked
          if (hasDateRange) {
            // Strict: need actual per-date evidence for the range
            if (!avail.dates.length) return false; // no date data → don't assume available
            const rangeSet = new Set(dateRange);
            const hasOpenInRange = avail.dates.some(d =>
              rangeSet.has(d.date) && (d.status === 'available' || d.status === 'limited')
            );
            if (!hasOpenInRange) return false;
          } else {
            // No range — show if confirmed bookable or has any open dates
            const confirmedBookable = avail.hasOnlineReservation === true;
            const hasOpenDates = !!getNearestAvailDate(r);
            if (!hasOpenDates && !confirmedBookable) return false;
          }
        }
        return true;
      })
    : browseResults;

  // How many restaurants still need detailed availability checks (respects cuisine filter)
  const cuisineFiltered = selectedCuisines.size > 0
    ? allResults.filter(r => matchesCuisine(r))
    : allResults;
  const anyBookable = cuisineFiltered.some(r => r.has_online_reservation);
  const uncheckedCount = cuisineFiltered.filter(r => {
    if (!r.tabelog_url || availabilityMap.has(r.tabelog_url)) return false;
    return anyBookable ? r.has_online_reservation : true;
  }).length;

  // Auto-fetch more pages when filtering and not enough results
  // For availability-based filters, wait until current results are all checked before loading more
  // When the ranked list is exhausted, automatically expand to broader Tabelog listing
  useEffect(() => {
    if (!isFiltering || filteredResults.length >= MIN_FILTERED || fetchingMore || browseLoading) return;
    const needsAvailData = showBookableOnly || showSpotsOpenOnly;
    if (needsAvailData && uncheckedCount > 40) return; // allow loading pages ahead while checks run

    const rankedDone = !hasNextPage || lastFetchedPage >= MAX_PAGES;
    const broadDone = broadSearch && (!broadHasNext || broadSearchPage >= MAX_PAGES);

    // If ranked list is exhausted but we haven't started broad search yet, switch to it
    if (rankedDone && !broadSearch && needsAvailData) {
      setBroadSearch(true);
      return; // next render will pick up the broad search
    }

    // If both ranked and broad are exhausted, nothing more to do
    if (rankedDone && broadDone) return;

    fetchMorePages();
  }, [isFiltering, filteredResults.length, hasNextPage, fetchingMore, browseLoading, lastFetchedPage, fetchMorePages, uncheckedCount, showBookableOnly, showSpotsOpenOnly, broadSearch, broadHasNext, broadSearchPage]);

  // Auto-browse on mount
  useEffect(() => { browse(city, 1); }, []);

  // Batch availability search using Tabelog's native date filtering (vac_net=1)
  // Debounced: waits 600ms after the last filter change before firing
  const batchSearchRunningRef = useRef(false);
  const batchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track search config (party size, meal) to decide merge vs replace on response
  const lastSearchConfigRef = useRef({ svt: '', svps: '', city: '' });
  useEffect(() => {
    // Clear any pending debounce
    if (batchDebounceRef.current) clearTimeout(batchDebounceRef.current);

    if (dateFilterBrowsedRef.current === effectiveDateFilterKey) return;
    if (tab !== 'browse' || !effectiveDateFilter || !filterDateFrom) {
      dateFilterBrowsedRef.current = effectiveDateFilterKey;
      return;
    }

    batchDebounceRef.current = setTimeout(() => {
      // Capture the key for this search so we can ignore stale responses
      const searchKey = effectiveDateFilterKey;
      dateFilterBrowsedRef.current = searchKey;

      const datesToSearch = hasDateRange ? dateRange : [filterDateFrom];
      const meal = filterMeals.size === 1
        ? (filterMeals.has('lunch') ? 'lunch' : 'dinner')
        : undefined;

      console.log(`[batch-avail] searching city=${city} dates=[${datesToSearch.join(', ')}] meal=${meal || 'any'} party=${filterPartySize}`);
      batchSearchRunningRef.current = true;
      setAvailChecking(true);

      api<{ availableByDate: Record<string, string[]>; restaurants: TabelogResult[]; timeSlots?: Record<string, Record<string, string[]>> }>('/availability/search', {
        method: 'POST',
        body: JSON.stringify({
          city,
          dates: datesToSearch,
          meal,
          partySize: filterPartySize,
        }),
      }).then(({ availableByDate, restaurants: searchRestaurants, timeSlots: timeSlotsMap }) => {
        // Ignore stale response if filters changed while search was running
        if (dateFilterBrowsedRef.current !== searchKey) {
          console.log(`[batch-avail] ignoring stale response (filters changed)`);
          return;
        }
        console.log(`[batch-avail] got ${searchRestaurants?.length || 0} unique restaurants, dates: ${Object.entries(availableByDate).map(([d, urls]) => `${d}=${urls.length}`).join(', ')}`);
        // Merge date-filtered restaurants into allResults (they may not be in the top-rated browse list)
        if (searchRestaurants?.length) {
          setAllResults(prev => {
            const existingUrls = new Set(prev.map(x => x.tabelog_url ? normalizeUrl(x.tabelog_url) : '').filter(Boolean));
            const newOnes = searchRestaurants.filter(
              (r: TabelogResult) => r.tabelog_url && !existingUrls.has(normalizeUrl(r.tabelog_url))
            );
            return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
          });
        }

        // Decide merge vs replace: if party size or meal changed, replace to avoid stale data.
        // If only dates changed, merge so restaurants from narrower search aren't lost.
        const currentConfig = { svt: effectiveDateFilter?.svt || '', svps: String(effectiveDateFilter?.svps || ''), city };
        const configChanged = lastSearchConfigRef.current.svt !== currentConfig.svt ||
                              lastSearchConfigRef.current.svps !== currentConfig.svps ||
                              lastSearchConfigRef.current.city !== currentConfig.city;
        lastSearchConfigRef.current = currentConfig;

        setAvailabilityMap(prev => {
          const next = configChanged ? new Map<string, ReservationAvailability>() : new Map(prev);
          for (const r of (searchRestaurants || [])) {
            if (!r.tabelog_url) continue;
            const normalUrl = normalizeUrl(r.tabelog_url);
            const dates: ReservationAvailability['dates'] = [];

            for (const [date, urls] of Object.entries(availableByDate)) {
              const normalizedUrls = new Set(urls.map(u => normalizeUrl(u)));
              const isAvailable = normalizedUrls.has(normalUrl) || normalizedUrls.has(r.tabelog_url);
              const slots = timeSlotsMap?.[r.tabelog_url]?.[date] || timeSlotsMap?.[normalUrl]?.[date] || [];
              dates.push({ date, status: isAvailable ? 'available' : 'unavailable', timeSlots: slots });
            }

            if (dates.length > 0) {
              next.set(r.tabelog_url, {
                tabelogUrl: normalUrl,
                hasOnlineReservation: dates.some(d => d.status === 'available'),
                reservationUrl: null,
                dates,
                checkedAt: new Date().toISOString(),
              });
            }
          }
          return next;
        });
      }).catch(err => {
        console.error('[batch-avail] search failed:', err);
      }).finally(() => {
        batchSearchRunningRef.current = false;
        setAvailChecking(false);
      });
    }, 600);

    return () => {
      if (batchDebounceRef.current) clearTimeout(batchDebounceRef.current);
    };
  }, [effectiveDateFilterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Queue-based availability checker: doesn't restart when new pages load
  const processAvailQueue = useCallback(async () => {
    if (availProcessingRef.current) return;
    availProcessingRef.current = true;
    setAvailChecking(true);

    const CONCURRENCY = 8;
    while (availQueueRef.current.length > 0) {
      const batch = availQueueRef.current.splice(0, CONCURRENCY);
      await Promise.all(batch.map(async (url) => {
        try {
          const result = await api<ReservationAvailability>('/availability/check', {
            method: 'POST',
            body: JSON.stringify({ tabelog_url: url, dateFrom: filterDateFrom || undefined, dateTo: filterDateTo || undefined, meals: filterMeals.size > 0 ? [...filterMeals] : undefined, partySize: filterPartySize || undefined }),
          });
          setAvailabilityMap(prev => new Map(prev).set(url, result));
        } catch { /* failed */ }
      }));
    }

    availProcessingRef.current = false;
    setAvailChecking(false);
  }, [filterDateFrom, filterDateTo, filterMeals, filterPartySize]);

  // Enqueue URLs for detailed availability checking — respects cuisine filter
  useEffect(() => {
    if (tab !== 'browse' || browseLoading) return;
    // Only do individual checks when "Spots Open" is active (need date data)
    // "Bookable Online" uses inline browse data — no individual checks needed
    if (!showSpotsOpenOnly) return;
    // Skip individual checks when Tabelog's native date filtering is active
    if (effectiveDateFilter) return;
    // Start with all results, then apply cuisine filter so we only check relevant restaurants
    let source = isFiltering ? allResults : browseResults;
    if (selectedCuisines.size > 0) {
      source = source.filter(r => matchesCuisine(r));
    }
    // Prefer checking only bookable restaurants, but if none have the flag (stale cache), check all
    const anyBookableInSource = source.some(r => r.has_online_reservation);
    const newUrls = source
      .filter(r => anyBookableInSource ? r.has_online_reservation : true)
      .map(r => r.tabelog_url)
      .filter((u): u is string => !!u && !availQueuedSetRef.current.has(u));
    if (newUrls.length === 0) return;

    console.log(`[avail-queue] enqueuing ${newUrls.length} URLs (anyBookable=${anyBookableInSource}, cuisines=${selectedCuisines.size})`);
    for (const u of newUrls) availQueuedSetRef.current.add(u);
    availQueueRef.current.push(...newUrls);
    processAvailQueue();
  }, [tab, browseLoading, allResults.length, browseResults.length, isFiltering, showSpotsOpenOnly, selectedCuisines, processAvailQueue]);

  // Reset queue when city changes
  useEffect(() => {
    availQueueRef.current.length = 0;
    availQueuedSetRef.current.clear();
  }, [city]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Remove "${name}" from your list?`)) return;
    await api(`/restaurants/${id}`, { method: 'DELETE' });
    loadSaved();
  };

  const handleSaved = () => {
    setShowForm(false);
    setEditingId(null);
    loadSaved();
  };

  const triggerFavoriteAnimation = (key: string) => {
    setAnimatingFavorite(key);
    setTimeout(() => setAnimatingFavorite(null), 500);
  };

  const toggleFavorite = async (id: string) => {
    triggerFavoriteAnimation(id);
    await api(`/restaurants/${id}/favorite`, { method: 'PATCH' });
    loadSaved();
  };

  // Save a browse result and immediately favorite it
  const saveAndFavorite = async (r: TabelogResult) => {
    if (!r.name) return;
    setSavingUrl(r.tabelog_url);
    if (r.tabelog_url) triggerFavoriteAnimation(r.tabelog_url);
    try {
      const created = await api<Restaurant>('/restaurants', {
        method: 'POST',
        body: JSON.stringify({
          name: r.name,
          name_ja: r.name_ja,
          tabelog_url: r.tabelog_url,
          tabelog_score: r.tabelog_score,
          cuisine: r.cuisine,
          area: r.area,
          city: r.city || city,
          price_range: r.price_range,
          image_url: r.image_url,
        }),
      });
      if (created?.id) {
        await api(`/restaurants/${created.id}/favorite`, { method: 'PATCH' });
      }
      loadSaved();
    } finally {
      setSavingUrl(null);
    }
  };

  const displayedSaved = useMemo(
    () => showFavoritesOnly ? saved.filter(r => r.is_favorite) : saved,
    [saved, showFavoritesOnly],
  );

  // Current list for keyboard navigation (works across both tabs)
  const currentList: (Restaurant | TabelogResult)[] = tab === 'saved' ? displayedSaved : filteredResults;

  // Reset selection when switching tabs or when list changes
  useEffect(() => {
    setSelectedRowIndex(0);
    setDetailIndex(null);
  }, [tab]);

  // Clamp selection when list changes
  useEffect(() => {
    setSelectedRowIndex(i => {
      if (currentList.length === 0) return 0;
      if (i >= currentList.length) return currentList.length - 1;
      return i;
    });
  }, [currentList.length]);

  // Unified keyboard nav (both tabs, list + detail panel)
  useEffect(() => {
    if (showForm) return;
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      const maxIdx = currentList.length - 1;

      if (detailIndex !== null) {
        // Detail panel is open
        if (key === 'Escape') { e.preventDefault(); setDetailIndex(null); }
        else if (key === 'j' || key === 'ArrowDown') {
          e.preventDefault();
          setDetailIndex(i => Math.min((i ?? 0) + 1, maxIdx));
          setSelectedRowIndex(i => Math.min(i + 1, maxIdx));
        } else if (key === 'k' || key === 'ArrowUp') {
          e.preventDefault();
          setDetailIndex(i => Math.max((i ?? 0) - 1, 0));
          setSelectedRowIndex(i => Math.max(i - 1, 0));
        } else if (key === 'f') {
          e.preventDefault();
          const r = currentList[detailIndex];
          if (r && 'id' in r) {
            toggleFavorite(r.id);
          } else if (r && r.tabelog_url) {
            const match = saved.find(s => s.tabelog_url && r.tabelog_url && normalizeUrl(s.tabelog_url) === normalizeUrl(r.tabelog_url));
            if (match) toggleFavorite(match.id);
            else saveAndFavorite(r as TabelogResult);
          }
        } else if (key === 't') {
          e.preventDefault();
          setShowTripModal(true);
        }
        return;
      }

      // List view
      if (key === 'j' || key === 'ArrowDown') {
        e.preventDefault();
        setSelectedRowIndex(i => Math.min(i + 1, maxIdx));
      } else if (key === 'k' || key === 'ArrowUp') {
        e.preventDefault();
        setSelectedRowIndex(i => Math.max(i - 1, 0));
      } else if (key === 'f' && selectedRowIndex >= 0 && selectedRowIndex < currentList.length) {
        e.preventDefault();
        const r = currentList[selectedRowIndex];
        if (r && 'id' in r) {
          toggleFavorite(r.id);
        } else if (r && r.tabelog_url) {
          const match = saved.find(s => s.tabelog_url && r.tabelog_url && normalizeUrl(s.tabelog_url) === normalizeUrl(r.tabelog_url));
          if (match) toggleFavorite(match.id);
          else saveAndFavorite(r as TabelogResult);
        }
      } else if (key === 'Enter' && selectedRowIndex >= 0 && selectedRowIndex < currentList.length) {
        e.preventDefault();
        setDetailIndex(selectedRowIndex);
      } else if (key === 't' && selectedRowIndex >= 0 && selectedRowIndex < currentList.length) {
        e.preventDefault();
        setShowTripModal(true);
      } else if (key === 'Escape') {
        e.preventDefault();
        setSelectedRowIndex(0);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tab, currentList, selectedRowIndex, detailIndex, showForm, navigate, saved]);

  // Scroll selected row into view (only when list view is showing)
  useEffect(() => {
    if (selectedRowIndex < 0 || detailIndex !== null) return;
    document.querySelector(`[data-row-index="${selectedRowIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedRowIndex, detailIndex]);

  const scoreColor = (score: number | null) =>
    !score ? 'text-gray-400' :
    score >= 4.0 ? 'text-red-600' :
    score >= 3.5 ? 'text-orange-500' :
    'text-gray-600';

  const statusSymbol = (s: string) => {
    switch (s) {
      case 'available': return { symbol: '◯', color: 'text-green-600' };
      case 'limited': return { symbol: '△', color: 'text-yellow-600' };
      case 'unavailable': return { symbol: '✕', color: 'text-red-500' };
      default: return { symbol: '?', color: 'text-gray-400' };
    }
  };

  return (
    <div>
      {/* Tabs */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'browse'}
            onClick={() => setTab('browse')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              tab === 'browse' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Browse Tabelog
            <kbd className="ml-1.5 text-[10px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded border border-gray-200">g b</kbd>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'saved'}
            onClick={() => setTab('saved')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              tab === 'saved' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Favorites ({saved.length})
            <kbd className="ml-1.5 text-[10px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded border border-gray-200">g f</kbd>
          </button>
        </div>
        {tab === 'saved' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFavoritesOnly(f => !f)}
              className={`px-3 py-2 text-sm font-medium rounded-md ${
                showFavoritesOnly
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {showFavoritesOnly ? '★ Favorites' : '☆ Favorites'}
              <kbd className="ml-1.5 text-[10px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded border border-gray-200">g f</kbd>
            </button>
            <button
              onClick={() => { setShowForm(true); setEditingId(null); }}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700"
            >
              Add Manually
            </button>
          </div>
        )}
      </div>

      {/* Detail Panel (replaces table when open) */}
      {detailIndex !== null && currentList[detailIndex] ? (
        <RestaurantDetailPanel
          restaurant={currentList[detailIndex]}
          onClose={() => setDetailIndex(null)}
          onNext={() => {
            if (detailIndex < currentList.length - 1) {
              setDetailIndex(detailIndex + 1);
              setSelectedRowIndex(detailIndex + 1);
            }
          }}
          onPrev={() => {
            if (detailIndex > 0) {
              setDetailIndex(detailIndex - 1);
              setSelectedRowIndex(detailIndex - 1);
            }
          }}
          hasPrev={detailIndex > 0}
          hasNext={detailIndex < currentList.length - 1}
          onFavoriteToggle={() => {
            const item = currentList[detailIndex];
            if (!item) return;
            if ('id' in item) {
              toggleFavorite((item as Restaurant).id);
            } else if (item.tabelog_url) {
              const match = saved.find(s => s.tabelog_url && item.tabelog_url && normalizeUrl(s.tabelog_url) === normalizeUrl(item.tabelog_url));
              if (match) toggleFavorite(match.id);
              else saveAndFavorite(item as TabelogResult);
            }
          }}
          isFavorited={(() => {
            const item = currentList[detailIndex];
            if (!item) return false;
            return 'id' in item
              ? !!(item as Restaurant).is_favorite
              : !!(item.tabelog_url && favoriteUrls.has(normalizeUrl(item.tabelog_url)));
          })()}
          isSaving={savingUrl === currentList[detailIndex]?.tabelog_url}
          favoriteAnimating={(() => {
            const item = currentList[detailIndex];
            if (!item || !animatingFavorite) return false;
            return ('id' in item && animatingFavorite === (item as Restaurant).id) ||
              (item.tabelog_url === animatingFavorite);
          })()}
          availability={(() => {
            const item = currentList[detailIndex];
            if (!item?.tabelog_url) return null;
            return availabilityMap.get(item.tabelog_url) ?? null;
          })()}
          filterDateFrom={filterDateFrom}
          filterDateTo={filterDateTo}
          filterMeals={filterMeals}
          filterPartySize={filterPartySize}
        />
      ) : (
        <>
          {/* Browse Tab */}
          {tab === 'browse' && (
            <div>
              {/* City filter */}
              <div className="mb-4 flex items-center gap-2 flex-wrap">
                {CITIES.map(c => (
                  <button
                    key={c}
                    onClick={() => handleCityChange(c)}
                    className={`px-3 py-1.5 text-sm rounded-full capitalize ${
                      c === city
                        ? 'bg-blue-600 text-white'
                        : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>

              {/* Cuisine filter */}
              {availableCuisines.length > 0 && !browseLoading && (
                <div className="mb-4 flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-gray-500 uppercase mr-1">Cuisine:</span>
                  {selectedCuisines.size > 0 && (
                    <button
                      onClick={() => setSelectedCuisines(new Set())}
                      className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 underline"
                    >
                      Clear
                    </button>
                  )}
                  {availableCuisines.map(c => (
                    <button
                      key={c}
                      onClick={() => toggleCuisine(c)}
                      className={`px-2.5 py-1 text-xs rounded-full ${
                        selectedCuisines.has(c)
                          ? 'bg-purple-600 text-white'
                          : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}

              {/* Availability filters */}
              {!browseLoading && (browseResults.length > 0 || allResults.length > 0) && (
                <div className="mb-4 flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-500 uppercase mr-1">Booking:</span>
                  <button
                    onClick={() => { setShowBookableOnly(v => !v); if (!showBookableOnly) setShowSpotsOpenOnly(false); }}
                    className={`px-3 py-1.5 text-xs rounded-full flex items-center gap-1.5 ${
                      showBookableOnly
                        ? 'bg-blue-600 text-white'
                        : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Bookable Online
                  </button>
                  <button
                    onClick={() => { setShowSpotsOpenOnly(v => !v); if (!showSpotsOpenOnly) setShowBookableOnly(false); }}
                    className={`px-3 py-1.5 text-xs rounded-full flex items-center gap-1.5 ${
                      showSpotsOpenOnly
                        ? 'bg-green-600 text-white'
                        : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <span>◯</span> Spots Open
                  </button>
                  {availChecking && (() => {
                    const totalToCheck = (isFiltering ? allResults : browseResults).length;
                    return (
                      <span className="text-xs text-gray-400 flex items-center gap-1.5">
                        <span className="inline-block w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        Checking availability ({availabilityMap.size}/{totalToCheck})
                      </span>
                    );
                  })()}
                </div>
              )}

              {/* Date range & meal filter — shown when booking filters are active */}
              {(showBookableOnly || showSpotsOpenOnly) && !browseLoading && (
                <div className="mb-4 flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-gray-500 uppercase mr-1">When:</span>
                  <div className="w-40">
                    <SmartDateInput
                      value={filterDateFrom}
                      onChange={setFilterDateFrom}
                      onRangeParsed={(start, end) => { setFilterDateFrom(start); setFilterDateTo(end); }}
                      label=""
                      placeholder="e.g., june 3-10"
                    />
                  </div>
                  <span className="text-xs text-gray-400">&rarr;</span>
                  <div className="w-40">
                    <SmartDateInput
                      value={filterDateTo}
                      onChange={setFilterDateTo}
                      label=""
                      placeholder="end date"
                      referenceDate={filterDateFrom ? new Date(filterDateFrom + 'T12:00:00') : undefined}
                    />
                  </div>
                  {(filterDateFrom || filterDateTo) && (
                    <button
                      onClick={() => { setFilterDateFrom(''); setFilterDateTo(''); }}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      clear
                    </button>
                  )}
                  {trips.length > 0 && (
                    <>
                      <span className="mx-1 text-gray-300">|</span>
                      <select
                        value=""
                        onChange={e => {
                          const trip = trips.find(t => t.id === e.target.value);
                          if (trip) {
                            setFilterDateFrom(trip.start_date);
                            setFilterDateTo(trip.end_date);
                            if (trip.city) {
                              const cityKey = CITIES.find(c => c.toLowerCase() === trip.city?.toLowerCase());
                              if (cityKey && cityKey !== city) handleCityChange(cityKey);
                            }
                          }
                        }}
                        className="px-2 py-1 text-xs border border-gray-200 rounded-md bg-white text-gray-600"
                      >
                        <option value="">Apply trip...</option>
                        {trips.map(t => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.start_date} &mdash; {t.end_date})
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <span className="mx-1 text-gray-300">|</span>
                  <button
                    onClick={() => toggleMeal('lunch')}
                    className={`px-2.5 py-1 text-xs rounded-full ${
                      filterMeals.has('lunch')
                        ? 'bg-amber-500 text-white'
                        : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Lunch
                  </button>
                  <button
                    onClick={() => toggleMeal('dinner')}
                    className={`px-2.5 py-1 text-xs rounded-full ${
                      filterMeals.has('dinner')
                        ? 'bg-indigo-500 text-white'
                        : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Dinner
                  </button>
                  <span className="mx-1 text-gray-300">|</span>
                  <select
                    value={filterPartySize}
                    onChange={e => setFilterPartySize(Number(e.target.value))}
                    className="px-2 py-1 text-xs border border-gray-200 rounded-md bg-white text-gray-600"
                  >
                    {[1,2,3,4,5,6,7,8,9,10].map(n => (
                      <option key={n} value={n}>{n} {n === 1 ? 'guest' : 'guests'}</option>
                    ))}
                  </select>
                </div>
              )}

              {(() => {
                const availFilterActive = showBookableOnly || showSpotsOpenOnly;
                const rankedCanLoad = hasNextPage && lastFetchedPage < MAX_PAGES;
                const broadCanLoad = !broadSearch || (broadHasNext && broadSearchPage < MAX_PAGES);
                const canLoadMore = rankedCanLoad || (availFilterActive && broadCanLoad);
                // "Bookable Online" is instant from browse data — no searching needed
                // "Spots Open" requires availability checks on bookable restaurants
                // When date filter is active, batch search via Tabelog handles it; otherwise individual checks
                const needsDateChecks = showSpotsOpenOnly && !effectiveDateFilter;
                const batchSearching = showSpotsOpenOnly && effectiveDateFilter && availChecking;
                const stillSearching = batchSearching || (needsDateChecks && (availChecking || fetchingMore || uncheckedCount > 0 || (filteredResults.length < MIN_FILTERED && canLoadMore)));
                return browseLoading ? (
                  <div className="text-center py-12">
                    <div className="inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <p className="mt-2 text-sm text-gray-500">Loading restaurants from Tabelog...</p>
                    <p className="text-xs text-gray-400 mt-1">This may take a few seconds (scraping live data)</p>
                  </div>
                ) : filteredResults.length === 0 && !stillSearching && !fetchingMore ? (
                  allResults.length === 0 ? (
                    <p className="text-gray-500 text-center py-8">No results found. Try another city.</p>
                  ) : availFilterActive ? (
                    <div className="py-8 text-center">
                      <div className="inline-flex items-center gap-2 px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg mb-3">
                        <span className="text-green-500">&#10003;</span>
                        <span className="text-sm text-gray-600">
                          Checked {allResults.length} restaurants across {lastFetchedPage + broadSearchPage} {(lastFetchedPage + broadSearchPage) === 1 ? 'page' : 'pages'} — {showSpotsOpenOnly ? 'no open spots found' : 'none bookable online'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400">Availability changes frequently. Try another city or check back later.</p>
                    </div>
                  ) : (
                    <p className="text-gray-500 text-center py-8">No restaurants match the selected cuisines.</p>
                  )
                ) : (
                <>
                  {stillSearching && (() => {
                    const totalPages = lastFetchedPage + broadSearchPage;
                    const checked = availabilityMap.size;
                    const total = allResults.length;
                    const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
                    return (
                      <div className="mb-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-blue-700 flex items-center gap-2">
                            <span className="inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
                            Searching for {showSpotsOpenOnly ? 'open spots' : 'bookable restaurants'}
                            {broadSearch && <span className="text-blue-400 text-xs">(expanded)</span>}
                          </span>
                          <span className="text-xs text-blue-600 font-medium tabular-nums">
                            {checked} / {total} checked
                            {filteredResults.length > 0 && <span className="text-green-600 ml-2">{filteredResults.length} found</span>}
                          </span>
                        </div>
                        <div className="w-full bg-blue-200 rounded-full h-1.5">
                          <div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="text-xs text-blue-400 mt-1">{totalPages} {totalPages === 1 ? 'page' : 'pages'} loaded</div>
                      </div>
                    );
                  })()}
                  <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-12">#</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Restaurant</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-20">Score</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Cuisine</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Area</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                          {hasDateRange ? dateRange.map(d => {
                            const label = new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                            return <th key={d} className="px-1 py-3 text-center text-[10px] font-medium text-gray-500 uppercase w-12">{label}</th>;
                          }) : (
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase w-28">Availability</th>
                          )}
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase w-24"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {filteredResults.map((r, idx) => {
                          const isItemSaved = r.tabelog_url ? savedUrls.has(normalizeUrl(r.tabelog_url)) : false;
                          const isSaving = savingUrl === r.tabelog_url;
                          return (
                            <tr
                              key={r.tabelog_url || idx}
                              data-row-index={idx}
                              className={`cursor-pointer ${idx === selectedRowIndex ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' : 'hover:bg-gray-50'}`}
                              onClick={() => { setSelectedRowIndex(idx); setDetailIndex(idx); }}
                            >
                              <td className="px-4 py-3 text-sm text-gray-400">
                                {isFiltering ? idx + 1 : (browsePage - 1) * 20 + idx + 1}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-3">
                                  {r.image_url && (
                                    <img src={r.image_url} alt="" className="w-10 h-10 rounded object-cover shrink-0"
                                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                  )}
                                  <div>
                                    <div className="text-sm font-medium text-gray-900">{r.name || 'Unknown'}</div>
                                    {r.tabelog_url && (
                                      <a href={r.tabelog_url} target="_blank" rel="noopener noreferrer"
                                        onClick={e => e.stopPropagation()}
                                        className="text-xs text-blue-500 hover:text-blue-700">
                                        View on Tabelog
                                      </a>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <span className={`text-sm font-semibold ${scoreColor(r.tabelog_score)}`}>
                                  {r.tabelog_score?.toFixed(2) ?? '—'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600">{r.cuisine || '—'}</td>
                              <td className="px-4 py-3 text-sm text-gray-600">{r.area || '—'}</td>
                              <td className="px-4 py-3 text-sm text-gray-600">{r.price_range || '—'}</td>
                              {hasDateRange ? dateRange.map(d => {
                                const avail = getAvail(r);
                                const dateData = avail?.dates.find(ad => ad.date === d);
                                const confirmedBookable = avail?.hasOnlineReservation === true;
                                if (dateData && dateData.status !== 'unknown') {
                                  const { symbol, color } = statusSymbol(dateData.status);
                                  return <td key={d} className={`px-1 py-3 text-center text-xs font-medium ${color}`}>{symbol}</td>;
                                }
                                if (confirmedBookable && !avail?.dates.length) {
                                  // Bookable but no per-date data — can't confirm availability
                                  const url = getReserveUrl(avail, r.tabelog_url);
                                  return (
                                    <td key={d} className="px-1 py-3 text-center">
                                      <a href={url} target="_blank" rel="noopener noreferrer"
                                        onClick={e => e.stopPropagation()}
                                        className="text-xs text-gray-400 hover:text-blue-600" title={`Check ${d} — availability unconfirmed`}>?</a>
                                    </td>
                                  );
                                }
                                if (confirmedBookable) {
                                  // Bookable with date data but this specific date wasn't in the data
                                  return <td key={d} className="px-1 py-3 text-center text-gray-300 text-xs">—</td>;
                                }
                                if (avail || !r.has_online_reservation) return <td key={d} className="px-1 py-3 text-center text-gray-300 text-xs">—</td>;
                                return <td key={d} className="px-1 py-3 text-center text-xs text-blue-400">...</td>;
                              }) : (
                              <td className="px-4 py-3 text-center">
                                {(() => {
                                  const avail = getAvail(r);
                                  const nearest = getNearestAvailDate(r);
                                  if (nearest) {
                                    const d = new Date(nearest.date + 'T00:00:00');
                                    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                    const symbol = nearest.status === 'limited' ? '△' : '◯';
                                    return (
                                      <span
                                        className={`text-xs font-medium ${nearest.status === 'limited' ? 'text-yellow-600' : 'text-green-600'}`}
                                        title={`Next: ${label}${nearest.timeSlots.length ? ' (' + nearest.timeSlots.join(', ') + ')' : ''}`}
                                      >
                                        {symbol} {label}
                                      </span>
                                    );
                                  }
                                  if (avail?.hasOnlineReservation) {
                                    const url = getReserveUrl(avail, r.tabelog_url);
                                    return (
                                      <a href={url} target="_blank" rel="noopener noreferrer"
                                        onClick={e => e.stopPropagation()}
                                        className="text-xs text-green-600 font-medium hover:text-green-700"
                                        title="Online booking confirmed — click to reserve">
                                        ◯ Reserve
                                      </a>
                                    );
                                  }
                                  if (avail) return <span className="text-gray-300 text-xs">—</span>;
                                  if (!r.has_online_reservation) return <span className="text-gray-300 text-xs">—</span>;
                                  return <span className="text-xs text-blue-400" title="Online booking available">Bookable</span>;
                                })()}
                              </td>
                              )}
                              <td className="px-4 py-3 text-right">
                                {(() => {
                                  const isFav = r.tabelog_url && favoriteUrls.has(normalizeUrl(r.tabelog_url));
                                  const isAnimating = (r.tabelog_url && animatingFavorite === r.tabelog_url) || (r.tabelog_url && saved.find(s => s.tabelog_url && r.tabelog_url && normalizeUrl(s.tabelog_url) === normalizeUrl(r.tabelog_url))?.id === animatingFavorite);
                                  return (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (isItemSaved) {
                                          const match = saved.find(s => s.tabelog_url && r.tabelog_url && normalizeUrl(s.tabelog_url) === normalizeUrl(r.tabelog_url));
                                          if (match) toggleFavorite(match.id);
                                        } else {
                                          saveAndFavorite(r);
                                        }
                                      }}
                                      disabled={isSaving}
                                      className={`inline-flex items-center px-3 py-1 text-xs font-medium rounded-md ${isAnimating ? 'animate-favorite-pop' : ''} ${
                                        isFav
                                          ? 'bg-amber-50 text-amber-600 border border-amber-200 hover:bg-amber-100'
                                          : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200'
                                      } disabled:opacity-50`}
                                    >
                                      {isSaving ? '...' : isFav ? '★ Favorited' : '☆ Favorite'}
                                    </button>
                                  );
                                })()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 flex items-center gap-4 text-xs text-gray-400">
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">j/k</kbd> navigate</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">f</kbd> favorite</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Enter</kbd> view</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">t</kbd> add to trip</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Esc</kbd> deselect</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">g f</kbd> view favorites</span>
                    </div>
                  </div>

                  {/* Pagination / Load more */}
                  {isFiltering ? (() => {
                    const totalPages = lastFetchedPage + broadSearchPage;
                    const allDone = (!hasNextPage || lastFetchedPage >= MAX_PAGES) && (!broadSearch || !broadHasNext || broadSearchPage >= MAX_PAGES);
                    return (
                    <div className="mt-4 flex items-center justify-between">
                      <span className="text-sm text-gray-500">
                        {filteredResults.length} matching from {allResults.length} restaurants ({totalPages} pages{broadSearch ? ', expanded' : ''})
                      </span>
                      {fetchingMore && (
                        <span className="text-sm text-gray-400 flex items-center gap-2">
                          <span className="inline-block w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                          Loading more...
                        </span>
                      )}
                      {!fetchingMore && !allDone && (
                        <button
                          onClick={fetchMorePages}
                          className="px-4 py-2 text-sm bg-white border border-gray-200 rounded-md hover:bg-gray-50"
                        >
                          Load more pages
                        </button>
                      )}
                      {allDone && (
                        <span className="text-xs text-gray-400">All pages loaded</span>
                      )}
                    </div>
                    );
                  })() : (
                    <div className="mt-4 flex items-center justify-between">
                      <button
                        onClick={() => goToPage(browsePage - 1)}
                        disabled={browsePage <= 1}
                        className="px-4 py-2 text-sm bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50"
                      >
                        Previous
                      </button>
                      <span className="text-sm text-gray-500">Page {browsePage}</span>
                      <button
                        onClick={() => goToPage(browsePage + 1)}
                        disabled={!hasNextPage}
                        className="px-4 py-2 text-sm bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              );
              })()}
            </div>
          )}

          {/* Saved Tab */}
          {tab === 'saved' && (
            <div>
              {showForm && (
                <div className="mb-6 bg-white rounded-lg border border-gray-200 p-6">
                  <RestaurantForm
                    restaurantId={editingId}
                    onSaved={handleSaved}
                    onCancel={() => { setShowForm(false); setEditingId(null); }}
                  />
                </div>
              )}

              {savedLoading ? (
                <p className="text-gray-500">Loading...</p>
              ) : saved.length === 0 ? (
                <p className="text-gray-500">No restaurants saved yet. Browse Tabelog to add some.</p>
              ) : (
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase w-10"></th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">#</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Score</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Cuisine</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Area</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Platforms</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {displayedSaved.map((r, idx) => (
                        <tr
                          key={r.id}
                          data-row-index={idx}
                          className={`cursor-pointer ${idx === selectedRowIndex ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' : 'hover:bg-gray-50'}`}
                          onClick={() => { setSelectedRowIndex(idx); setDetailIndex(idx); }}
                        >
                          <td className="px-2 py-3 text-center">
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleFavorite(r.id); }}
                              className={`text-lg leading-none inline-block ${r.is_favorite ? 'text-amber-400' : 'text-gray-300 hover:text-amber-300'} ${animatingFavorite === r.id ? 'animate-favorite-pop' : ''}`}
                              aria-label={r.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                            >
                              {r.is_favorite ? '★' : '☆'}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">{r.rank ?? idx + 1}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              {r.image_url && (
                                <img src={r.image_url} alt="" className="w-10 h-10 rounded object-cover shrink-0"
                                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              )}
                              <div>
                                <span className="text-sm font-medium text-blue-600">
                                  {r.name}
                                </span>
                                {r.name_ja && <div className="text-xs text-gray-400">{r.name_ja}</div>}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-sm font-semibold ${scoreColor(r.tabelog_score)}`}>
                              {r.tabelog_score?.toFixed(2) ?? '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">{r.cuisine || '—'}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{r.area || r.city || '—'}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{r.price_range || '—'}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1">
                              {[
                                r.omakase_url && 'O',
                                r.tablecheck_url && 'TC',
                                r.tableall_url && 'TA',
                              ].filter(Boolean).map(p => (
                                <span key={p as string} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                                  {p}
                                </span>
                              ))}
                              {!r.omakase_url && !r.tablecheck_url && !r.tableall_url && (
                                <span className="text-gray-400 text-sm">—</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right space-x-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); setEditingId(r.id); setShowForm(true); }}
                              className="text-sm text-gray-600 hover:text-gray-900"
                            >
                              Edit
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(r.id, r.name); }}
                              className="text-sm text-red-600 hover:text-red-800"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 flex items-center gap-4 text-xs text-gray-400">
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">j/k</kbd> navigate</span>
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">f</kbd> favorite</span>
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Enter</kbd> view</span>
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">t</kbd> add to trip</span>
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">g f</kbd> view favorites</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {showTripModal && (() => {
        const idx = detailIndex ?? selectedRowIndex;
        const r = currentList[idx];
        if (!r) return null;
        return (
          <AddToTripModal
            restaurant={r}
            city={city}
            onClose={() => setShowTripModal(false)}
            onAdded={() => { setShowTripModal(false); loadSaved(); }}
          />
        );
      })()}
    </div>
  );
}
