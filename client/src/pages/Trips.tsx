import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { format } from 'date-fns';
import { isInputFocused } from '../lib/keyboard';
import TripForm from '../components/TripForm';
import TripDetailPanel from '../components/TripDetailPanel';
import { useIsMobile } from '../hooks/useIsMobile';

interface Trip {
  id: string;
  name: string;
  city: string | null;
  start_date: string;
  end_date: string;
  is_active: number;
  notes: string | null;
}

export default function Trips() {
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedRowIndex, setSelectedRowIndex] = useState(0);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    api<Trip[]>('/trips').then(setTrips).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // Handle ?action=new from command palette / keyboard shortcut
  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setShowForm(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Clamp selection when list changes
  useEffect(() => {
    setSelectedRowIndex(i => {
      if (trips.length === 0) return 0;
      if (i >= trips.length) return trips.length - 1;
      return i;
    });
  }, [trips.length]);

  // Keyboard navigation
  useEffect(() => {
    if (showForm) return;
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      const maxIdx = trips.length - 1;

      // TripDetailPanel handles its own keyboard (j/k for rows, Esc to close)
      if (detailIndex !== null) return;

      if (key === 'j' || key === 'ArrowDown') {
        e.preventDefault();
        setSelectedRowIndex(i => Math.min(i + 1, maxIdx));
      } else if (key === 'k' || key === 'ArrowUp') {
        e.preventDefault();
        setSelectedRowIndex(i => Math.max(i - 1, 0));
      } else if (key === 'Enter' && selectedRowIndex >= 0 && selectedRowIndex < trips.length) {
        e.preventDefault();
        setDetailIndex(selectedRowIndex);
      } else if (key === 'Escape') {
        e.preventDefault();
        setSelectedRowIndex(0);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [trips, selectedRowIndex, detailIndex, showForm]);

  // Scroll selected row into view
  useEffect(() => {
    if (selectedRowIndex < 0 || detailIndex !== null) return;
    document.querySelector(`[data-trip-index="${selectedRowIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedRowIndex, detailIndex]);

  const handleActivate = async (trip: Trip) => {
    await api(`/trips/${trip.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...trip, is_active: trip.is_active ? 0 : 1 }),
    });
    load();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete trip "${name}"?`)) return;
    await api(`/trips/${id}`, { method: 'DELETE' });
    load();
  };

  const formatDate = (d: string) => {
    try { return format(new Date(d), 'MMM d, yyyy'); } catch { return d; }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Trips</h1>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700"
        >
          New Trip
          <kbd className="ml-1.5 text-[10px] text-blue-200 bg-blue-700 px-1 py-0.5 rounded border border-blue-500">c</kbd>
        </button>
      </div>

      {showForm && (
        <TripForm
          onCreated={() => { setShowForm(false); load(); }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Mobile: full-screen detail overlay */}
      {isMobile && detailIndex !== null && trips[detailIndex] && (
        <div className="fixed inset-0 z-40 bg-white overflow-y-auto animate-slide-in-right">
          <TripDetailPanel
            tripId={trips[detailIndex].id}
            onClose={() => setDetailIndex(null)}
            onNext={() => {
              if (detailIndex < trips.length - 1) {
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
            hasNext={detailIndex < trips.length - 1}
            onActivate={() => handleActivate(trips[detailIndex]!)}
            isActive={!!trips[detailIndex]!.is_active}
          />
        </div>
      )}

      {/* Desktop: Detail Panel (replaces list when open) */}
      {!isMobile && detailIndex !== null && trips[detailIndex] ? (
        <TripDetailPanel
          tripId={trips[detailIndex].id}
          onClose={() => setDetailIndex(null)}
          onNext={() => {
            if (detailIndex < trips.length - 1) {
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
          hasNext={detailIndex < trips.length - 1}
          onActivate={() => handleActivate(trips[detailIndex]!)}
          isActive={!!trips[detailIndex]!.is_active}
        />
      ) : (
        <>
          {loading ? (
            <p className="text-gray-500">Loading...</p>
          ) : trips.length === 0 ? (
            <p className="text-gray-500">No trips yet. Create one to get started.</p>
          ) : (
            <>
              <div className="space-y-3">
                {trips.map((trip, idx) => (
                  <div
                    key={trip.id}
                    data-trip-index={idx}
                    onClick={() => { setSelectedRowIndex(idx); setDetailIndex(idx); }}
                    className={`bg-white rounded-lg border p-4 flex items-center justify-between cursor-pointer ${
                      idx === selectedRowIndex
                        ? 'ring-1 ring-inset ring-blue-200 bg-blue-50'
                        : trip.is_active ? 'border-blue-300 bg-blue-50/50' : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div>
                      <span className="text-sm font-medium text-blue-600">
                        {trip.name}
                      </span>
                      <div className="text-sm text-gray-500 mt-0.5">
                        {formatDate(trip.start_date)} — {formatDate(trip.end_date)}
                        {trip.city && <span className="ml-2 text-gray-400">({trip.city})</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleActivate(trip); }}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                          trip.is_active
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {trip.is_active ? 'Active' : 'Apply'}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(trip.id, trip.name); }}
                        className="text-sm text-red-600 hover:text-red-800"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 px-4 py-2 flex items-center gap-4 text-xs text-gray-400">
                <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">j/k</kbd> navigate</span>
                <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Enter</kbd> view</span>
                <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">c</kbd> new trip</span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
