import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { format } from 'date-fns';
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

  const load = () => {
    api<TripDetail>(`/trips/${tripId}`).then(setTrip);
    api<Restaurant[]>('/restaurants').then(setAllRestaurants);
  };

  useEffect(() => { load(); }, [tripId]);

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
  }, [trip?.restaurants.length, tripId]);

  const addRestaurant = async () => {
    if (!selectedRestaurant) return;
    await api(`/trips/${tripId}/restaurants`, {
      method: 'POST',
      body: JSON.stringify({ restaurant_id: selectedRestaurant }),
    });
    setSelectedRestaurant('');
    load();
  };

  const removeRestaurant = async (restaurantId: string) => {
    await api(`/trips/${tripId}/restaurants/${restaurantId}`, { method: 'DELETE' });
    load();
  };

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

            {/* Restaurant list grouped by day/meal */}
            <div className="bg-white rounded-lg border border-gray-200">
              <div className="px-4 py-3 border-b border-gray-200">
                <h2 className="text-sm font-medium text-gray-900">
                  Restaurants ({trip.restaurants.length})
                </h2>
              </div>
              {trip.restaurants.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-500 text-center">No restaurants added yet.</p>
              ) : (() => {
                const scheduled = trip.restaurants.filter(r => r.day_assigned);
                const unscheduled = trip.restaurants.filter(r => !r.day_assigned);

                // Group scheduled by day
                const byDay = new Map<string, TripRestaurant[]>();
                for (const r of scheduled) {
                  const day = r.day_assigned!;
                  if (!byDay.has(day)) byDay.set(day, []);
                  byDay.get(day)!.push(r);
                }
                const sortedDays = [...byDay.keys()].sort();

                return (
                  <div className="divide-y divide-gray-200">
                    {sortedDays.map(day => {
                      const dayRestaurants = byDay.get(day)!;
                      const lunch = dayRestaurants.filter(r => r.meal === 'lunch');
                      const dinner = dayRestaurants.filter(r => r.meal === 'dinner');
                      const other = dayRestaurants.filter(r => r.meal !== 'lunch' && r.meal !== 'dinner');
                      let dayLabel: string;
                      try { dayLabel = format(new Date(day), 'EEE, MMM d'); } catch { dayLabel = day; }

                      return (
                        <div key={day} className="px-4 py-3">
                          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">{dayLabel}</div>
                          {lunch.length > 0 && (
                            <div className="mb-2">
                              <span className="text-xs text-amber-600 font-medium">Lunch</span>
                              {lunch.map(r => (
                                <RestaurantRow key={r.id} r={r} scoreColor={scoreColor} onRemove={removeRestaurant} availability={r.tabelog_url ? availMap.get(r.tabelog_url) : undefined} />
                              ))}
                            </div>
                          )}
                          {dinner.length > 0 && (
                            <div className="mb-2">
                              <span className="text-xs text-indigo-600 font-medium">Dinner</span>
                              {dinner.map(r => (
                                <RestaurantRow key={r.id} r={r} scoreColor={scoreColor} onRemove={removeRestaurant} availability={r.tabelog_url ? availMap.get(r.tabelog_url) : undefined} />
                              ))}
                            </div>
                          )}
                          {other.map(r => (
                            <RestaurantRow key={r.id} r={r} scoreColor={scoreColor} onRemove={removeRestaurant} availability={r.tabelog_url ? availMap.get(r.tabelog_url) : undefined} />
                          ))}
                        </div>
                      );
                    })}
                    {unscheduled.length > 0 && (
                      <div className="px-4 py-3">
                        <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Unscheduled</div>
                        {unscheduled.map(r => (
                          <RestaurantRow key={r.id} r={r} scoreColor={scoreColor} onRemove={removeRestaurant} availability={r.tabelog_url ? availMap.get(r.tabelog_url) : undefined} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </div>

      {/* Keyboard hints footer */}
      <div className="py-2 border-t border-gray-100 flex items-center gap-4 text-xs text-gray-400">
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">j/k</kbd> prev/next trip</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Esc</kbd> back to list</span>
      </div>
    </div>
  );
}

function RestaurantRow({
  r,
  scoreColor,
  onRemove,
  availability,
}: {
  r: { id: string; name: string; name_ja?: string | null; image_url: string | null; tabelog_score: number | null; cuisine: string | null; area: string | null; is_favorite: number };
  scoreColor: (s: number | null) => string;
  onRemove: (id: string) => void;
  availability?: ReservationAvailability;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 hover:bg-gray-50 rounded">
      <div className="flex items-center gap-3">
        {r.image_url && (
          <img src={r.image_url} alt="" className="w-8 h-8 rounded object-cover shrink-0"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        )}
        <div>
          <div className="flex items-center gap-1.5">
            <Link
              to={`/restaurants/${r.id}`}
              className="text-sm font-medium text-blue-600 hover:text-blue-800"
            >
              {r.is_favorite ? <span className="text-amber-400 mr-1">★</span> : null}
              {r.name}
            </Link>
            {availability && (
              availability.hasOnlineReservation
                ? <span className="text-green-600 text-xs" title="Online reservation available">◯</span>
                : <span className="text-gray-400 text-xs" title="No online reservation">✕</span>
            )}
          </div>
          <div className="flex gap-2 mt-0.5">
            {r.tabelog_score && (
              <span className={`text-xs font-semibold ${scoreColor(r.tabelog_score)}`}>
                {r.tabelog_score.toFixed(2)}
              </span>
            )}
            {r.cuisine && <span className="text-xs text-gray-400">{r.cuisine}</span>}
            {r.area && <span className="text-xs text-gray-400">{r.area}</span>}
          </div>
        </div>
      </div>
      <button
        onClick={() => onRemove(r.id)}
        className="text-xs text-red-600 hover:text-red-800"
      >
        Remove
      </button>
    </div>
  );
}
