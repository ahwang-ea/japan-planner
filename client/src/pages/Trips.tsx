import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { format } from 'date-fns';

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
  const [trips, setTrips] = useState<Trip[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: '', city: '', start_date: '', end_date: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api<Trip[]>('/trips').then(setTrips).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.start_date || !form.end_date) return;
    setSaving(true);
    await api('/trips', { method: 'POST', body: JSON.stringify(form) });
    setForm({ name: '', city: '', start_date: '', end_date: '', notes: '' });
    setShowForm(false);
    setSaving(false);
    load();
  };

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
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-4">Create Trip</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Trip Name *</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g., Tokyo May 2025"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input
                value={form.city}
                onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
                placeholder="e.g., Tokyo"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date *</label>
              <input
                type="date"
                value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End Date *</label>
              <input
                type="date"
                value={form.end_date}
                onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
          </div>
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div className="mt-4 flex gap-2">
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-700">Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : trips.length === 0 ? (
        <p className="text-gray-500">No trips yet. Create one to get started.</p>
      ) : (
        <div className="space-y-3">
          {trips.map(trip => (
            <div key={trip.id} className={`bg-white rounded-lg border p-4 flex items-center justify-between ${
              trip.is_active ? 'border-blue-300 bg-blue-50' : 'border-gray-200'
            }`}>
              <div>
                <Link to={`/trips/${trip.id}`} className="text-sm font-medium text-blue-600 hover:text-blue-800">
                  {trip.name}
                </Link>
                <div className="text-sm text-gray-500 mt-0.5">
                  {formatDate(trip.start_date)} — {formatDate(trip.end_date)}
                  {trip.city && <span className="ml-2 text-gray-400">({trip.city})</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleActivate(trip)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                    trip.is_active
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {trip.is_active ? 'Active' : 'Apply'}
                </button>
                <button
                  onClick={() => handleDelete(trip.id, trip.name)}
                  className="text-sm text-red-600 hover:text-red-800"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
