import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { format, eachDayOfInterval, parseISO } from 'date-fns';
import type { Restaurant } from '../pages/Restaurants';

interface ReservationAvailability {
  tabelogUrl: string;
  hasOnlineReservation: boolean;
  reservationUrl: string | null;
  dates: { date: string; status: string; timeSlots: string[] }[];
  checkedAt: string;
  error?: string;
}

interface TripRestaurant extends Restaurant {
  sort_order: number;
  day_assigned: string | null;
  meal: string | null;
  trip_notes: string | null;
  trip_restaurant_id: string;
  status: 'potential' | 'booked';
  booked_via: string | null;
  auto_dates: number;
}

interface TripDetail {
  id: string;
  name: string;
  city: string | null;
  start_date: string;
  end_date: string;
  is_active: number;
  notes: string | null;
  restaurants: TripRestaurant[];
}

interface SuggestionAction {
  trId: string;
  restaurantName: string;
  from: { day: string; meal: string };
  to: { day: string; meal: string };
}

interface Suggestion {
  type: 'swap' | 'move' | 'conflict';
  description: string;
  actions: SuggestionAction[];
}

interface Props {
  tripId: string;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onActivate: () => void;
  isActive: boolean;
}

const PLATFORMS = [
  { key: 'tabelog', label: 'Tabelog' },
  { key: 'omakase', label: 'Omakase' },
  { key: 'tablecheck', label: 'TableCheck' },
  { key: 'tableall', label: 'TableAll' },
  { key: 'phone', label: 'Phone' },
  { key: 'other', label: 'Other' },
] as const;

type Mode = 'normal' | 'move' | 'book' | 'suggestions';

export default function TripDetailPanel({
  tripId,
  onClose,
  onNext,
  onPrev,
  hasPrev,
  hasNext,
  onActivate,
  isActive,
}: Props) {
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [allRestaurants, setAllRestaurants] = useState<Restaurant[]>([]);
  const [selectedRestaurant, setSelectedRestaurant] = useState('');
  const [availMap, setAvailMap] = useState<Map<string, ReservationAvailability>>(new Map());
  const [checkingAvail, setCheckingAvail] = useState(false);
  const availAbortRef = useRef<AbortController | null>(null);
  const [availRefreshKey, setAvailRefreshKey] = useState(0);

  // Row navigation
  const [selectedRowIdx, setSelectedRowIdx] = useState(0);

  // Mode state
  const [mode, setMode] = useState<Mode>('normal');

  // Move mode state
  const [moveDate, setMoveDate] = useState<string | null>(null);
  const [moveMeal, setMoveMeal] = useState<'lunch' | 'dinner'>('dinner');

  // Suggestions
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedSuggIdx, setSelectedSuggIdx] = useState(0);

  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const load = useCallback(() => {
    api<TripDetail>(`/trips/${tripId}`).then(setTrip).catch(() => {});
    api<Restaurant[]>('/restaurants').then(setAllRestaurants).catch(() => {});
  }, [tripId]);

  useEffect(() => { load(); }, [load]);

  // Flat list of restaurants for keyboard navigation
  const flatList = useMemo(() => trip?.restaurants || [], [trip]);

  // Trip dates for move mode
  const tripDates = useMemo(() => {
    if (!trip) return [];
    try {
      return eachDayOfInterval({
        start: parseISO(trip.start_date),
        end: parseISO(trip.end_date),
      });
    } catch {
      return [];
    }
  }, [trip]);

  // Auto-check availability for all trip restaurants
  useEffect(() => {
    if (!trip || trip.restaurants.length === 0) return;
    const urls = trip.restaurants
      .map(r => r.tabelog_url)
      .filter((u): u is string => !!u && !availMap.has(u));
    if (urls.length === 0) return;

    availAbortRef.current?.abort();
    const abort = new AbortController();
    availAbortRef.current = abort;

    setCheckingAvail(true);
    const CONCURRENCY = 3;
    (async () => {
      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        if (abort.signal.aborted) break;
        const batch = urls.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (url) => {
          if (abort.signal.aborted) return;
          try {
            const result = await api<ReservationAvailability>('/availability/check', {
              method: 'POST',
              body: JSON.stringify({ tabelog_url: url }),
              signal: abort.signal,
            });
            if (!abort.signal.aborted) {
              setAvailMap(prev => new Map(prev).set(url, result));
            }
          } catch { /* aborted or failed */ }
        }));
      }
      if (!abort.signal.aborted) setCheckingAvail(false);
    })();

    return () => { abort.abort(); };
  }, [trip?.restaurants.length, tripId, availRefreshKey]);

  // Auto-sync auto_dates restaurants when availability changes
  const syncedRef = useRef<Set<string>>(new Set());
  const syncingRef = useRef(false);
  useEffect(() => {
    if (!trip || syncingRef.current || availMap.size === 0) return;
    // Find unique restaurant_ids that have auto_dates=1
    const autoRestaurants = new Map<string, string>(); // restaurant_id -> tabelog_url
    for (const r of trip.restaurants) {
      if (r.auto_dates && r.tabelog_url && !autoRestaurants.has(r.id)) {
        autoRestaurants.set(r.id, r.tabelog_url);
      }
    }
    if (autoRestaurants.size === 0) return;
    const toSync: [string, string][] = [];
    for (const [restaurantId, url] of autoRestaurants) {
      const avail = availMap.get(url);
      if (!avail?.dates?.length) continue;
      const key = `${restaurantId}:${avail.dates.map(d => `${d.date}:${d.status}`).join(',')}`;
      if (syncedRef.current.has(key)) continue;
      syncedRef.current.add(key);
      toSync.push([restaurantId, url]);
    }
    if (toSync.length > 0) {
      syncingRef.current = true;
      (async () => {
        try {
          for (const [restaurantId, url] of toSync) {
            const avail = availMap.get(url);
            if (!avail?.dates?.length) continue;
            await api(`/trips/${tripId}/restaurants/sync`, {
              method: 'POST',
              body: JSON.stringify({
                restaurant_id: restaurantId,
                availability: { dates: avail.dates },
              }),
            });
          }
        } catch { /* ignore sync errors */ }
        syncingRef.current = false;
        load();
      })();
    }
  }, [trip, availMap, tripId, load]);

  // Scroll focused row into view
  useEffect(() => {
    const el = rowRefs.current.get(selectedRowIdx);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedRowIdx]);

  const addRestaurant = async () => {
    if (!selectedRestaurant) return;
    await api(`/trips/${tripId}/restaurants`, {
      method: 'POST',
      body: JSON.stringify({ restaurant_id: selectedRestaurant }),
    });
    setSelectedRestaurant('');
    load();
  };

  const bookRestaurant = async (trId: string, bookedVia?: string) => {
    await api(`/trips/${tripId}/restaurants/${trId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'booked', booked_via: bookedVia || 'tabelog' }),
    });
    load();
  };

  const unbookRestaurant = async (trId: string) => {
    await api(`/trips/${tripId}/restaurants/${trId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'potential' }),
    });
    load();
  };

  const removeByTrId = async (trId: string) => {
    await api(`/trips/${tripId}/trip-restaurants/${trId}`, { method: 'DELETE' });
    load();
  };

  const moveRestaurant = async (trId: string, dayAssigned: string, meal: string) => {
    await api(`/trips/${tripId}/restaurants/${trId}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ day_assigned: dayAssigned, meal }),
    });
    load();
  };

  const runOptimize = async () => {
    const availPayload: Record<string, { dates: { date: string; status: string }[] }> = {};
    for (const [url, avail] of availMap) {
      availPayload[url] = { dates: avail.dates };
    }
    const result = await api<{ suggestions: Suggestion[] }>(`/trips/${tripId}/optimize`, {
      method: 'POST',
      body: JSON.stringify({ availability: availPayload }),
    });
    setSuggestions(result.suggestions);
    setSelectedSuggIdx(0);
    if (result.suggestions.length > 0) {
      setMode('suggestions');
    }
  };

  const toggleAutoDates = async (trId: string) => {
    const r = flatList.find(x => x.trip_restaurant_id === trId);
    if (!r) return;
    await api(`/trips/${tripId}/restaurants/${trId}/auto-dates`, {
      method: 'PATCH',
      body: JSON.stringify({ auto_dates: !r.auto_dates }),
    });
    load();
  };

  const applySuggestion = async (suggestion: Suggestion) => {
    for (const action of suggestion.actions) {
      await api(`/trips/${tripId}/restaurants/${action.trId}/assign`, {
        method: 'PATCH',
        body: JSON.stringify({ day_assigned: action.to.day, meal: action.to.meal }),
      });
    }
    setSuggestions(prev => prev.filter(s => s !== suggestion));
    setSelectedSuggIdx(0);
    load();
  };

  const refreshAvailability = useCallback(() => {
    availAbortRef.current?.abort();
    setAvailMap(new Map());
    syncedRef.current.clear();
    setCheckingAvail(false);
    setAvailRefreshKey(k => k + 1);
  }, []);

  // Keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
      if (inInput) return;

      // Move mode shortcuts
      if (mode === 'move') {
        if (e.key === 'Escape') {
          e.preventDefault();
          setMode('normal');
          return;
        }
        if (e.key === 'l') { e.preventDefault(); setMoveMeal('lunch'); return; }
        if (e.key === 'd') { e.preventDefault(); setMoveMeal('dinner'); return; }
        if (e.key >= '1' && e.key <= '9') {
          const idx = parseInt(e.key) - 1;
          if (idx < tripDates.length) {
            e.preventDefault();
            setMoveDate(format(tripDates[idx]!, 'yyyy-MM-dd'));
          }
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setMoveDate(prev => {
            if (!prev || tripDates.length === 0) return prev;
            const idx = tripDates.findIndex(d => format(d, 'yyyy-MM-dd') === prev);
            if (idx > 0) return format(tripDates[idx - 1]!, 'yyyy-MM-dd');
            return prev;
          });
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setMoveDate(prev => {
            if (!prev || tripDates.length === 0) return prev;
            const idx = tripDates.findIndex(d => format(d, 'yyyy-MM-dd') === prev);
            if (idx >= 0 && idx < tripDates.length - 1) return format(tripDates[idx + 1]!, 'yyyy-MM-dd');
            return prev;
          });
          return;
        }
        if (e.key === 'Enter' && moveDate) {
          e.preventDefault();
          const r = flatList[selectedRowIdx];
          if (r) {
            moveRestaurant(r.trip_restaurant_id, moveDate, moveMeal);
            setMode('normal');
          }
          return;
        }
        return;
      }

      // Book mode — pick platform
      if (mode === 'book') {
        if (e.key === 'Escape') {
          e.preventDefault();
          setMode('normal');
          return;
        }
        if (e.key >= '1' && e.key <= '6') {
          e.preventDefault();
          const r = flatList[selectedRowIdx];
          if (r) {
            bookRestaurant(r.trip_restaurant_id, PLATFORMS[parseInt(e.key) - 1]!.key);
            setMode('normal');
          }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const r = flatList[selectedRowIdx];
          if (r) {
            bookRestaurant(r.trip_restaurant_id, 'tabelog');
            setMode('normal');
          }
          return;
        }
        return;
      }

      // Suggestions mode
      if (mode === 'suggestions') {
        if (e.key === 'Escape') {
          e.preventDefault();
          setMode('normal');
          setSuggestions([]);
          return;
        }
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedSuggIdx(prev => Math.min(prev + 1, suggestions.length - 1));
          return;
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedSuggIdx(prev => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const s = suggestions[selectedSuggIdx];
          if (s) applySuggestion(s);
          return;
        }
        return;
      }

      // Normal mode
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      // j/k for row navigation
      if (e.key === 'j') {
        e.preventDefault();
        setSelectedRowIdx(prev => Math.min(prev + 1, flatList.length - 1));
        return;
      }
      if (e.key === 'k') {
        e.preventDefault();
        setSelectedRowIdx(prev => Math.max(prev - 1, 0));
        return;
      }

      // b = book
      if (e.key === 'b') {
        e.preventDefault();
        const r = flatList[selectedRowIdx];
        if (r && r.status === 'potential') {
          setMode('book');
        }
        return;
      }

      // u = unbook
      if (e.key === 'u') {
        e.preventDefault();
        const r = flatList[selectedRowIdx];
        if (r && r.status === 'booked') {
          unbookRestaurant(r.trip_restaurant_id);
        }
        return;
      }

      // x = remove
      if (e.key === 'x') {
        e.preventDefault();
        const r = flatList[selectedRowIdx];
        if (r) {
          removeByTrId(r.trip_restaurant_id);
          setSelectedRowIdx(prev => Math.max(0, Math.min(prev, flatList.length - 2)));
        }
        return;
      }

      // m = move mode
      if (e.key === 'm') {
        e.preventDefault();
        const r = flatList[selectedRowIdx];
        if (r) {
          setMoveDate(r.day_assigned || (tripDates[0] ? format(tripDates[0], 'yyyy-MM-dd') : null));
          setMoveMeal((r.meal as 'lunch' | 'dinner') || 'dinner');
          setMode('move');
        }
        return;
      }

      // a = toggle auto_dates
      if (e.key === 'a') {
        e.preventDefault();
        const r = flatList[selectedRowIdx];
        if (r) toggleAutoDates(r.trip_restaurant_id);
        return;
      }

      // o = optimize
      if (e.key === 'o') {
        e.preventDefault();
        runOptimize();
        return;
      }

      // r = refresh availability
      if (e.key === 'r') {
        e.preventDefault();
        refreshAvailability();
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, flatList, selectedRowIdx, suggestions, selectedSuggIdx, moveDate, moveMeal, tripDates, onClose, refreshAvailability]);

  const formatDate = (d: string) => {
    try { return format(new Date(d), 'MMM d, yyyy'); } catch { return d; }
  };

  const scoreColor = (score: number | null) =>
    !score ? 'text-gray-400' :
    score >= 4.0 ? 'text-red-600' :
    score >= 3.5 ? 'text-orange-500' :
    'text-gray-600';

  const tripRestaurantIds = trip ? new Set(trip.restaurants.map(r => r.id)) : new Set();
  const availableRestaurants = allRestaurants.filter(r => !tripRestaurantIds.has(r.id));

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between py-3 border-b border-gray-200">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
        >
          <span className="text-lg leading-none">&larr;</span>
          <span>Back</span>
          <kbd className="ml-1 px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-xs text-gray-400">Esc</kbd>
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={onPrev}
            disabled={!hasPrev}
            className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 text-gray-500"
            aria-label="Previous"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={onNext}
            disabled={!hasNext}
            className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 text-gray-500"
            aria-label="Next"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto py-6">
        {!trip ? (
          <p className="text-gray-500">Loading...</p>
        ) : (
          <>
            {/* Trip info */}
            <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">{trip.name}</h1>
                  <p className="text-sm text-gray-500 mt-1">
                    {formatDate(trip.start_date)} — {formatDate(trip.end_date)}
                    {trip.city && <span className="ml-2">({trip.city})</span>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {checkingAvail && (
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <span className="inline-block w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                      Checking
                    </span>
                  )}
                  <button
                    onClick={refreshAvailability}
                    disabled={checkingAvail}
                    className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-40 flex items-center gap-1"
                    title="Refresh availability (r)"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <kbd className="text-[10px] text-gray-400">r</kbd>
                  </button>
                  <button
                    onClick={onActivate}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                      isActive
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {isActive ? 'Active' : 'Set Active'}
                  </button>
                </div>
              </div>
              {trip.notes && <p className="mt-3 text-sm text-gray-600">{trip.notes}</p>}
            </div>

            {/* Mode banners */}
            {mode === 'move' && (
              <MoveModeBar
                tripDates={tripDates}
                moveDate={moveDate}
                moveMeal={moveMeal}
                restaurantName={flatList[selectedRowIdx]?.name || ''}
              />
            )}

            {mode === 'book' && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-green-800">
                    Book "{flatList[selectedRowIdx]?.name}" — pick platform
                  </h3>
                  <kbd className="px-1 py-0.5 bg-green-100 rounded border border-green-300 text-xs text-green-600">Esc</kbd>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PLATFORMS.map((p, idx) => (
                    <span key={p.key} className="text-xs text-green-700">
                      <kbd className="px-1 py-0.5 bg-green-100 rounded border border-green-300 text-green-600 mr-0.5">{idx + 1}</kbd>
                      {p.label}
                    </span>
                  ))}
                  <span className="text-xs text-green-700 ml-2">
                    <kbd className="px-1 py-0.5 bg-green-100 rounded border border-green-300 text-green-600 mr-0.5">Enter</kbd>
                    Tabelog (default)
                  </span>
                </div>
              </div>
            )}

            {/* Suggestions panel */}
            {mode === 'suggestions' && suggestions.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-amber-800">
                    Suggestions ({suggestions.length})
                  </h3>
                  <span className="text-xs text-amber-500">
                    <kbd className="px-1 py-0.5 bg-amber-100 rounded border border-amber-300 text-amber-600">j/k</kbd> navigate
                    <kbd className="ml-2 px-1 py-0.5 bg-amber-100 rounded border border-amber-300 text-amber-600">Enter</kbd> apply
                    <kbd className="ml-2 px-1 py-0.5 bg-amber-100 rounded border border-amber-300 text-amber-600">Esc</kbd> dismiss
                  </span>
                </div>
                <div className="space-y-1">
                  {suggestions.map((s, i) => (
                    <div
                      key={i}
                      className={`flex items-center justify-between py-2 px-2 rounded text-xs ${
                        i === selectedSuggIdx
                          ? 'bg-amber-200 text-amber-900 ring-2 ring-amber-400'
                          : 'text-amber-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${s.type === 'conflict' ? 'bg-red-400' : 'bg-amber-400'}`} />
                        {s.description}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Add restaurant */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Add Restaurant</label>
                  <select
                    value={selectedRestaurant}
                    onChange={e => setSelectedRestaurant(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  >
                    <option value="">Select a restaurant...</option>
                    {availableRestaurants.map(r => (
                      <option key={r.id} value={r.id}>
                        {r.name} {r.tabelog_score ? `(${r.tabelog_score.toFixed(2)})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={addRestaurant}
                  disabled={!selectedRestaurant}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Day × Meal grid */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              {trip.restaurants.length === 0 && tripDates.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-500 text-center">No restaurants added yet.</p>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase w-24"></th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-amber-600 uppercase border-l border-gray-200">Lunch</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-indigo-600 uppercase border-l border-gray-200">Dinner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tripDates.map(date => {
                      const dateStr = format(date, 'yyyy-MM-dd');
                      let dayLabel: string;
                      try { dayLabel = format(date, 'EEE, MMM d'); } catch { dayLabel = dateStr; }
                      const dayRestaurants = trip.restaurants.filter(r => r.day_assigned === dateStr);
                      const lunch = dayRestaurants.filter(r => r.meal === 'lunch');
                      const dinner = dayRestaurants.filter(r => r.meal === 'dinner');

                      const sortByAvail = (a: TripRestaurant, b: TripRestaurant) => {
                        if (a.status !== b.status) return a.status === 'booked' ? -1 : 1;
                        const aS = getDateStatus(a.tabelog_url, dateStr, availMap);
                        const bS = getDateStatus(b.tabelog_url, dateStr, availMap);
                        const order: Record<string, number> = { available: 0, limited: 1, unavailable: 3 };
                        return (order[aS ?? ''] ?? 2) - (order[bS ?? ''] ?? 2);
                      };
                      const sortedLunch = [...lunch].sort(sortByAvail);
                      const sortedDinner = [...dinner].sort(sortByAvail);

                      return (
                        <tr key={dateStr} className="border-b border-gray-100 align-top">
                          <td className="px-3 py-2 text-xs font-medium text-gray-500 whitespace-nowrap">{dayLabel}</td>
                          <td className="px-2 py-1.5 border-l border-gray-100 min-w-[200px]">
                            {sortedLunch.length === 0 ? (
                              <span className="text-xs text-gray-300 px-1">—</span>
                            ) : sortedLunch.map(r => {
                              const idx = flatList.indexOf(r);
                              const ds = getDateStatus(r.tabelog_url, dateStr, availMap);
                              return (
                                <RestaurantRow
                                  key={r.trip_restaurant_id}
                                  r={r}
                                  scoreColor={scoreColor}
                                  onRemove={() => removeByTrId(r.trip_restaurant_id)}
                                  onBook={() => { setSelectedRowIdx(idx); setMode('book'); }}
                                  onUnbook={() => unbookRestaurant(r.trip_restaurant_id)}
                                  dateStatus={ds}
                                  isFocused={idx === selectedRowIdx && mode === 'normal'}
                                  refCallback={(el) => { if (el) rowRefs.current.set(idx, el); else rowRefs.current.delete(idx); }}
                                />
                              );
                            })}
                          </td>
                          <td className="px-2 py-1.5 border-l border-gray-100 min-w-[200px]">
                            {sortedDinner.length === 0 ? (
                              <span className="text-xs text-gray-300 px-1">—</span>
                            ) : sortedDinner.map(r => {
                              const idx = flatList.indexOf(r);
                              const ds = getDateStatus(r.tabelog_url, dateStr, availMap);
                              return (
                                <RestaurantRow
                                  key={r.trip_restaurant_id}
                                  r={r}
                                  scoreColor={scoreColor}
                                  onRemove={() => removeByTrId(r.trip_restaurant_id)}
                                  onBook={() => { setSelectedRowIdx(idx); setMode('book'); }}
                                  onUnbook={() => unbookRestaurant(r.trip_restaurant_id)}
                                  dateStatus={ds}
                                  isFocused={idx === selectedRowIdx && mode === 'normal'}
                                  refCallback={(el) => { if (el) rowRefs.current.set(idx, el); else rowRefs.current.delete(idx); }}
                                />
                              );
                            })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Unscheduled restaurants */}
            {(() => {
              const unscheduled = trip.restaurants.filter(r => !r.day_assigned);
              if (unscheduled.length === 0) return null;
              return (
                <div className="bg-white rounded-lg border border-gray-200 mt-4 px-4 py-3">
                  <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Unscheduled ({unscheduled.length})</div>
                  {unscheduled.map(r => {
                    const idx = flatList.indexOf(r);
                    return (
                      <RestaurantRow
                        key={r.trip_restaurant_id}
                        r={r}
                        scoreColor={scoreColor}
                        onRemove={() => removeByTrId(r.trip_restaurant_id)}
                        onBook={() => { setSelectedRowIdx(idx); setMode('book'); }}
                        onUnbook={() => unbookRestaurant(r.trip_restaurant_id)}
                        dateStatus={null}
                        isFocused={idx === selectedRowIdx && mode === 'normal'}
                        refCallback={(el) => { if (el) rowRefs.current.set(idx, el); else rowRefs.current.delete(idx); }}
                      />
                    );
                  })}
                </div>
              );
            })()}
          </>
        )}
      </div>

      {/* Keyboard hints footer */}
      <div className="py-2 border-t border-gray-100 flex items-center gap-3 text-xs text-gray-400 flex-wrap">
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">j/k</kbd> navigate</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">b</kbd> book</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">u</kbd> unbook</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">m</kbd> move</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">x</kbd> remove</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">a</kbd> auto</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">o</kbd> optimize</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">r</kbd> refresh</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Esc</kbd> back</span>
      </div>
    </div>
  );
}

// Move mode bar
function MoveModeBar({
  tripDates,
  moveDate,
  moveMeal,
  restaurantName,
}: {
  tripDates: Date[];
  moveDate: string | null;
  moveMeal: 'lunch' | 'dinner';
  restaurantName: string;
}) {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-blue-800">
          Move "{restaurantName}"
        </h3>
        <kbd className="px-1 py-0.5 bg-blue-100 rounded border border-blue-300 text-xs text-blue-600">Esc</kbd>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1 mb-2">
        {tripDates.map((d, idx) => {
          const dateStr = format(d, 'yyyy-MM-dd');
          const isSelected = moveDate === dateStr;
          return (
            <button
              key={dateStr}
              onClick={() => {}} // keyboard-only
              className={`shrink-0 px-3 py-2 rounded-md text-xs font-medium border relative ${
                isSelected
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-700 border-gray-200'
              }`}
            >
              {idx < 9 && (
                <span className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full text-[10px] flex items-center justify-center ${
                  isSelected ? 'bg-blue-800 text-blue-200' : 'bg-gray-200 text-gray-500'
                }`}>{idx + 1}</span>
              )}
              <div>{format(d, 'EEE')}</div>
              <div className="text-sm">{format(d, 'MMM d')}</div>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex gap-2">
          {(['lunch', 'dinner'] as const).map(meal => (
            <span key={meal} className={`px-3 py-1 rounded-md text-xs font-medium border capitalize ${
              moveMeal === meal
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 border-gray-200'
            }`}>
              {meal}
              <kbd className={`ml-1 text-[10px] px-0.5 rounded ${
                moveMeal === meal ? 'text-blue-200' : 'text-gray-400'
              }`}>{meal[0]}</kbd>
            </span>
          ))}
        </div>
        <span className="text-xs text-blue-500 ml-auto">
          <kbd className="px-1 py-0.5 bg-blue-100 rounded border border-blue-300 text-blue-600">Enter</kbd> confirm
        </span>
      </div>
    </div>
  );
}

function platformLabel(via: string | null): string {
  if (!via) return '';
  const found = PLATFORMS.find(p => p.key === via);
  return found ? found.label : via;
}

function getDateStatus(
  url: string | null,
  date: string,
  availMap: Map<string, ReservationAvailability>,
): string | null {
  if (!url) return null;
  const avail = availMap.get(url);
  if (!avail?.dates?.length) return null;
  const d = avail.dates.find(x => x.date === date);
  return d?.status ?? null;
}

const STATUS_DOT: Record<string, { symbol: string; color: string; title: string }> = {
  available: { symbol: '◯', color: 'text-green-600', title: 'Available' },
  limited: { symbol: '△', color: 'text-yellow-600', title: 'Limited' },
  unavailable: { symbol: '✕', color: 'text-red-400', title: 'Unavailable' },
};

function RestaurantRow({
  r,
  scoreColor,
  onRemove,
  onBook,
  onUnbook,
  dateStatus,
  isFocused,
  refCallback,
}: {
  r: TripRestaurant;
  scoreColor: (s: number | null) => string;
  onRemove: () => void;
  onBook: () => void;
  onUnbook: () => void;
  dateStatus: string | null;
  isFocused: boolean;
  refCallback: (el: HTMLDivElement | null) => void;
}) {
  const isBooked = r.status === 'booked';
  const isUnavailable = !isBooked && dateStatus === 'unavailable';
  const dot = dateStatus ? STATUS_DOT[dateStatus] : null;

  return (
    <div
      ref={refCallback}
      className={`flex items-center justify-between py-1 px-1.5 rounded group ${
        isBooked
          ? 'bg-green-50 border-l-2 border-green-500'
          : isUnavailable
            ? 'border-l-2 border-dashed border-red-200 opacity-40'
            : 'border-l-2 border-dashed border-gray-200'
      } ${isFocused ? 'ring-2 ring-blue-400 ring-offset-1' : ''}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {dot && <span className={`text-xs shrink-0 ${dot.color}`} title={dot.title}>{dot.symbol}</span>}
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <Link
              to={`/restaurants/${r.id}`}
              className={`text-sm font-medium truncate ${
                isBooked ? 'text-green-700' : isUnavailable ? 'text-gray-400 line-through' : 'text-blue-600 hover:text-blue-800'
              }`}
            >
              {r.is_favorite ? <span className="text-amber-400 mr-0.5">★</span> : null}
              {r.name}
            </Link>
            {isBooked && (
              <span className="text-[10px] font-medium px-1 py-0.5 bg-green-100 text-green-700 rounded shrink-0">
                {r.booked_via ? platformLabel(r.booked_via) : 'Booked'}
              </span>
            )}
            {r.auto_dates ? (
              <span className="text-[10px] font-medium px-1 py-0.5 bg-blue-100 text-blue-600 rounded shrink-0">Auto</span>
            ) : null}
          </div>
          <div className="flex gap-1.5">
            {r.tabelog_score && (
              <span className={`text-[11px] font-semibold ${scoreColor(r.tabelog_score)}`}>
                {r.tabelog_score.toFixed(2)}
              </span>
            )}
            {r.cuisine && <span className="text-[11px] text-gray-400">{r.cuisine}</span>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {!isBooked && !isUnavailable && (
          <button onClick={onBook} className="text-[11px] text-green-600 hover:text-green-800 font-medium">
            Book
          </button>
        )}
        {isBooked && (
          <button onClick={onUnbook} className="text-[11px] text-gray-500 hover:text-gray-700">
            Unbook
          </button>
        )}
        <button onClick={onRemove} className="text-[11px] text-red-500 hover:text-red-700">
          ×
        </button>
      </div>
    </div>
  );
}
