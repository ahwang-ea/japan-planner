import { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../lib/api';
import { eachDayOfInterval, format, parseISO } from 'date-fns';
import type { Restaurant, TabelogResult } from '../pages/Restaurants';

interface Trip {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_active: number;
}

interface AvailabilityDate {
  date: string;
  status: 'available' | 'limited' | 'unavailable' | 'unknown';
  timeSlots: string[];
}

interface AvailabilityData {
  dates: AvailabilityDate[];
}

interface Props {
  restaurant: Restaurant | TabelogResult;
  city?: string;
  availability?: AvailabilityData | null;
  onClose: () => void;
  onAdded: () => void;
}

type Meal = 'lunch' | 'dinner';
type BookingStatus = 'potential' | 'booked';

const PLATFORMS = [
  { key: 'tabelog', label: 'Tabelog' },
  { key: 'omakase', label: 'Omakase' },
  { key: 'tablecheck', label: 'TableCheck' },
  { key: 'tableall', label: 'TableAll' },
  { key: 'phone', label: 'Phone' },
  { key: 'other', label: 'Other' },
] as const;

function isSavedRestaurant(r: Restaurant | TabelogResult): r is Restaurant {
  return 'id' in r;
}

function detectPlatform(restaurant: Restaurant | TabelogResult): string {
  if (isSavedRestaurant(restaurant)) {
    if (restaurant.omakase_url) return 'omakase';
    if (restaurant.tablecheck_url) return 'tablecheck';
    if (restaurant.tableall_url) return 'tableall';
  }
  return 'tabelog';
}

export default function AddToTripModal({ restaurant, city, availability, onClose, onAdded }: Props) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [selectedMeal, setSelectedMeal] = useState<Meal>('dinner');
  const [bothMeals, setBothMeals] = useState(false);
  const [status, setStatus] = useState<BookingStatus>('potential');
  const [bookedVia, setBookedVia] = useState<string>(detectPlatform(restaurant));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Trip[]>('/trips').then(t => {
      setTrips(t);
      const active = t.find(x => x.is_active);
      if (active) {
        setSelectedTripId(active.id);
        setSelectedDates(new Set([active.start_date]));
      } else if (t.length > 0 && t[0]) {
        setSelectedTripId(t[0].id);
        setSelectedDates(new Set([t[0].start_date]));
      }
    });
  }, []);

  const selectedTrip = trips.find(t => t.id === selectedTripId);

  const tripDates = useMemo(() =>
    selectedTrip
      ? eachDayOfInterval({
          start: parseISO(selectedTrip.start_date),
          end: parseISO(selectedTrip.end_date),
        })
      : [],
    [selectedTrip]
  );

  // Compute which trip dates are bookable based on availability data
  const bookableDates = useMemo(() => {
    if (!availability?.dates) return new Set<string>();
    const tripDateStrs = new Set(tripDates.map(d => format(d, 'yyyy-MM-dd')));
    return new Set(
      availability.dates
        .filter(d => (d.status === 'available' || d.status === 'limited') && tripDateStrs.has(d.date))
        .map(d => d.date)
    );
  }, [availability, tripDates]);

  const toggleDate = useCallback((dateStr: string) => {
    setSelectedDates(prev => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      return next;
    });
  }, []);

  const selectAllBookable = useCallback(() => {
    if (bookableDates.size > 0) {
      setSelectedDates(new Set(bookableDates));
    } else {
      // No availability data — select all trip dates
      setSelectedDates(new Set(tripDates.map(d => format(d, 'yyyy-MM-dd'))));
    }
    setBothMeals(true);
  }, [bookableDates, tripDates]);

  const handleSubmit = useCallback(async () => {
    if (!selectedTripId || selectedDates.size === 0) return;
    setSaving(true);
    setError(null);

    try {
      let restaurantId: string;

      if (isSavedRestaurant(restaurant)) {
        restaurantId = restaurant.id;
      } else {
        const created = await api<Restaurant>('/restaurants', {
          method: 'POST',
          body: JSON.stringify({
            name: restaurant.name,
            name_ja: restaurant.name_ja,
            tabelog_url: restaurant.tabelog_url,
            tabelog_score: restaurant.tabelog_score,
            cuisine: restaurant.cuisine,
            area: restaurant.area,
            city: restaurant.city || city,
            price_range: restaurant.price_range,
            image_url: restaurant.image_url,
          }),
        });
        restaurantId = created.id;
      }

      // Add to each selected date x meal(s)
      const dates = [...selectedDates].sort();
      const meals = bothMeals ? ['lunch', 'dinner'] : [selectedMeal];
      const isAutoDate = bothMeals; // "all bookable" implies auto_dates
      for (const date of dates) {
        for (const m of meals) {
          await api(`/trips/${selectedTripId}/restaurants`, {
            method: 'POST',
            body: JSON.stringify({
              restaurant_id: restaurantId,
              day_assigned: date,
              meal: m,
              status,
              booked_via: status === 'booked' ? bookedVia : undefined,
              auto_dates: isAutoDate,
            }),
          });
        }
      }

      onAdded();
    } catch {
      setError('Failed to add restaurant to trip');
    } finally {
      setSaving(false);
    }
  }, [selectedTripId, selectedDates, selectedMeal, bothMeals, status, bookedVia, restaurant, city, onAdded]);

  // Global keyboard handler for modal shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl+Enter to submit
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      // Skip letter shortcuts if a select/input is focused
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';

      if (!inInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // l/d for lunch/dinner (clears bothMeals)
        if (e.key === 'l') {
          e.preventDefault();
          setSelectedMeal('lunch');
          setBothMeals(false);
          return;
        }
        if (e.key === 'd') {
          e.preventDefault();
          setSelectedMeal('dinner');
          setBothMeals(false);
          return;
        }

        // p/b for potential/booked
        if (e.key === 'p') {
          e.preventDefault();
          setStatus('potential');
          return;
        }
        if (e.key === 'b') {
          e.preventDefault();
          setStatus('booked');
          return;
        }

        // a = select all bookable dates (or all dates if no availability)
        if (e.key === 'a') {
          e.preventDefault();
          selectAllBookable();
          return;
        }

        // Number keys 1-9
        if (e.key >= '1' && e.key <= '9') {
          if (status === 'booked') {
            // 1-6 picks platform
            const idx = parseInt(e.key) - 1;
            if (idx < PLATFORMS.length) {
              e.preventDefault();
              setBookedVia(PLATFORMS[idx]!.key);
              return;
            }
          }
          // Toggle date by position
          const dateIdx = parseInt(e.key) - 1;
          if (dateIdx < tripDates.length) {
            e.preventDefault();
            toggleDate(format(tripDates[dateIdx]!, 'yyyy-MM-dd'));
          }
          return;
        }

        // 0 = clear all dates
        if (e.key === '0') {
          e.preventDefault();
          setSelectedDates(new Set());
          return;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tripDates, onClose, handleSubmit, status, selectAllBookable, toggleDate]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-md mx-4 p-6"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Add to Trip</h2>
        <p className="text-sm text-gray-500 mb-4 truncate">{restaurant.name || 'Unknown'}</p>

        {trips.length === 0 ? (
          <p className="text-sm text-gray-500 py-4">No trips found. Create a trip first.</p>
        ) : (
          <div className="space-y-4">
            {/* Trip selector */}
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Trip</label>
              <select
                value={selectedTripId || ''}
                onChange={e => {
                  setSelectedTripId(e.target.value);
                  const t = trips.find(x => x.id === e.target.value);
                  if (t) setSelectedDates(new Set([t.start_date]));
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              >
                {trips.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name} {t.is_active ? '(active)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Date picker — multi-select */}
            {tripDates.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-gray-500 uppercase">
                    Dates
                    {status !== 'booked' && (
                      <span className="ml-2 normal-case font-normal text-gray-400">
                        <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">1-{Math.min(tripDates.length, 9)}</kbd> toggle
                      </span>
                    )}
                  </label>
                  <button
                    onClick={selectAllBookable}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
                  >
                    {bookableDates.size > 0 ? `All bookable (${bookableDates.size})` : 'All dates'}
                    <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500 text-[10px]">a</kbd>
                  </button>
                </div>
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {tripDates.map((d, idx) => {
                    const dateStr = format(d, 'yyyy-MM-dd');
                    const isSelected = selectedDates.has(dateStr);
                    const isBookable = bookableDates.has(dateStr);
                    return (
                      <button
                        key={dateStr}
                        onClick={() => toggleDate(dateStr)}
                        className={`shrink-0 px-3 py-2 rounded-md text-xs font-medium border relative ${
                          isSelected
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        {idx < 9 && status !== 'booked' && (
                          <span className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full text-[10px] flex items-center justify-center ${
                            isSelected ? 'bg-blue-800 text-blue-200' : 'bg-gray-200 text-gray-500'
                          }`}>{idx + 1}</span>
                        )}
                        <div>{format(d, 'EEE')}</div>
                        <div className="text-sm">{format(d, 'MMM d')}</div>
                        {bookableDates.size > 0 && (
                          <div className={`text-[10px] mt-0.5 ${isSelected ? 'text-blue-200' : isBookable ? 'text-green-500' : 'text-gray-300'}`}>
                            {isBookable ? '◯' : '✕'}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                {selectedDates.size > 1 && (
                  <p className="text-xs text-blue-600 mt-1">{selectedDates.size} dates selected</p>
                )}
              </div>
            )}

            {/* Meal selector */}
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Meal</label>
              <div className="flex gap-2">
                {(['lunch', 'dinner'] as Meal[]).map(meal => (
                  <button
                    key={meal}
                    onClick={() => { setSelectedMeal(meal); setBothMeals(false); }}
                    className={`flex-1 px-4 py-2 rounded-md text-sm font-medium border capitalize ${
                      !bothMeals && selectedMeal === meal
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {meal}
                    <kbd className={`ml-1.5 text-[10px] px-1 py-0.5 rounded border ${
                      !bothMeals && selectedMeal === meal
                        ? 'text-blue-200 bg-blue-700 border-blue-500'
                        : 'text-gray-400 bg-gray-100 border-gray-200'
                    }`}>{meal[0]}</kbd>
                  </button>
                ))}
              </div>
              {bothMeals && (
                <p className="text-xs text-blue-600 mt-1 flex items-center gap-1">
                  Both meals (lunch + dinner)
                  <button onClick={() => setBothMeals(false)} className="text-gray-400 hover:text-gray-600 underline">clear</button>
                </p>
              )}
            </div>

            {/* Status selector */}
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Status</label>
              <div className="flex gap-2">
                {(['potential', 'booked'] as BookingStatus[]).map(s => (
                  <button
                    key={s}
                    onClick={() => setStatus(s)}
                    className={`flex-1 px-4 py-2 rounded-md text-sm font-medium border capitalize ${
                      status === s
                        ? s === 'booked'
                          ? 'bg-green-600 text-white border-green-600'
                          : 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {s}
                    <kbd className={`ml-1.5 text-[10px] px-1 py-0.5 rounded border ${
                      status === s
                        ? s === 'booked'
                          ? 'text-green-200 bg-green-700 border-green-500'
                          : 'text-blue-200 bg-blue-700 border-blue-500'
                        : 'text-gray-400 bg-gray-100 border-gray-200'
                    }`}>{s[0]}</kbd>
                  </button>
                ))}
              </div>
            </div>

            {/* Platform picker (only when booked) */}
            {status === 'booked' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">
                  Booked Via
                  <span className="ml-2 normal-case font-normal text-gray-400">
                    <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">1-6</kbd>
                  </span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {PLATFORMS.map((platform, idx) => (
                    <button
                      key={platform.key}
                      onClick={() => setBookedVia(platform.key)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium border relative ${
                        bookedVia === platform.key
                          ? 'bg-green-600 text-white border-green-600'
                          : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <span className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full text-[10px] flex items-center justify-center ${
                        bookedVia === platform.key ? 'bg-green-800 text-green-200' : 'bg-gray-200 text-gray-500'
                      }`}>{idx + 1}</span>
                      {platform.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-xs text-red-600">{error}</p>}

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleSubmit}
                disabled={saving || !selectedTripId || selectedDates.size === 0}
                className={`px-4 py-2 text-white text-sm font-medium rounded-md disabled:opacity-50 ${
                  status === 'booked'
                    ? 'bg-green-600 hover:bg-green-700'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {saving
                  ? 'Adding...'
                  : status === 'booked'
                    ? `Add as Booked${selectedDates.size > 1 ? ` (${selectedDates.size} dates${bothMeals ? ' × 2 meals' : ''})` : ''}`
                    : `Add as Potential${selectedDates.size > 1 ? ` (${selectedDates.size} dates${bothMeals ? ' × 2 meals' : ''})` : ''}`}
              </button>
              <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900">
                Cancel
              </button>
              <span className="text-xs text-gray-400 ml-auto flex items-center gap-3">
                <span><kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">&#8984;Enter</kbd></span>
                <span><kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">Esc</kbd></span>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
