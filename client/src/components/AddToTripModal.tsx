import { useEffect, useState, useCallback } from 'react';
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

interface Props {
  restaurant: Restaurant | TabelogResult;
  city?: string;
  onClose: () => void;
  onAdded: () => void;
}

type Meal = 'lunch' | 'dinner';

function isSavedRestaurant(r: Restaurant | TabelogResult): r is Restaurant {
  return 'id' in r;
}

export default function AddToTripModal({ restaurant, city, onClose, onAdded }: Props) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedMeal, setSelectedMeal] = useState<Meal>('dinner');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Trip[]>('/trips').then(t => {
      setTrips(t);
      const active = t.find(x => x.is_active);
      if (active) {
        setSelectedTripId(active.id);
        setSelectedDate(active.start_date);
      } else if (t.length > 0 && t[0]) {
        setSelectedTripId(t[0].id);
        setSelectedDate(t[0].start_date);
      }
    });
  }, []);

  const selectedTrip = trips.find(t => t.id === selectedTripId);

  const tripDates = selectedTrip
    ? eachDayOfInterval({
        start: parseISO(selectedTrip.start_date),
        end: parseISO(selectedTrip.end_date),
      })
    : [];

  const handleSubmit = useCallback(async () => {
    if (!selectedTripId || !selectedDate) return;
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

      await api(`/trips/${selectedTripId}/restaurants`, {
        method: 'POST',
        body: JSON.stringify({
          restaurant_id: restaurantId,
          day_assigned: selectedDate,
          meal: selectedMeal,
        }),
      });

      onAdded();
    } catch {
      setError('Failed to add restaurant to trip');
    } finally {
      setSaving(false);
    }
  }, [selectedTripId, selectedDate, selectedMeal, restaurant, city, onAdded]);

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
        // l/d for lunch/dinner
        if (e.key === 'l') {
          e.preventDefault();
          setSelectedMeal('lunch');
          return;
        }
        if (e.key === 'd') {
          e.preventDefault();
          setSelectedMeal('dinner');
          return;
        }

        // Number keys 1-9 to pick date by position
        if (e.key >= '1' && e.key <= '9') {
          const dateIdx = parseInt(e.key) - 1;
          if (dateIdx < tripDates.length) {
            e.preventDefault();
            setSelectedDate(format(tripDates[dateIdx]!, 'yyyy-MM-dd'));
          }
          return;
        }
      }

      // Arrow keys work even when select is focused
      if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSelectedDate(prev => {
          if (!prev || tripDates.length === 0) return prev;
          const idx = tripDates.findIndex(d => format(d, 'yyyy-MM-dd') === prev);
          if (idx > 0) return format(tripDates[idx - 1]!, 'yyyy-MM-dd');
          return prev;
        });
      } else if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSelectedDate(prev => {
          if (!prev || tripDates.length === 0) return prev;
          const idx = tripDates.findIndex(d => format(d, 'yyyy-MM-dd') === prev);
          if (idx >= 0 && idx < tripDates.length - 1) return format(tripDates[idx + 1]!, 'yyyy-MM-dd');
          return prev;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tripDates, onClose, handleSubmit]);

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
                  if (t) setSelectedDate(t.start_date);
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

            {/* Date picker */}
            {tripDates.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">
                  Date
                  <span className="ml-2 normal-case font-normal text-gray-400">
                    <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">&larr;&rarr;</kbd> or <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">1-{Math.min(tripDates.length, 9)}</kbd>
                  </span>
                </label>
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {tripDates.map((d, idx) => {
                    const dateStr = format(d, 'yyyy-MM-dd');
                    const isSelected = selectedDate === dateStr;
                    return (
                      <button
                        key={dateStr}
                        onClick={() => setSelectedDate(dateStr)}
                        className={`shrink-0 px-3 py-2 rounded-md text-xs font-medium border relative ${
                          isSelected
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
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
              </div>
            )}

            {/* Meal selector */}
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Meal</label>
              <div className="flex gap-2">
                {(['lunch', 'dinner'] as Meal[]).map(meal => (
                  <button
                    key={meal}
                    onClick={() => setSelectedMeal(meal)}
                    className={`flex-1 px-4 py-2 rounded-md text-sm font-medium border capitalize ${
                      selectedMeal === meal
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {meal}
                    <kbd className={`ml-1.5 text-[10px] px-1 py-0.5 rounded border ${
                      selectedMeal === meal
                        ? 'text-blue-200 bg-blue-700 border-blue-500'
                        : 'text-gray-400 bg-gray-100 border-gray-200'
                    }`}>{meal[0]}</kbd>
                  </button>
                ))}
              </div>
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleSubmit}
                disabled={saving || !selectedTripId || !selectedDate}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Adding...' : 'Add to Trip'}
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
