import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { format } from 'date-fns';
import type { Restaurant } from './Restaurants';

interface Trip {
  id: string;
  name: string;
  city: string | null;
  start_date: string;
  end_date: string;
  is_active: number;
  notes: string | null;
  restaurants: (Restaurant & { sort_order: number; day_assigned: string | null; trip_notes: string | null; trip_restaurant_id: string })[];
}

export default function TripDetail() {
  const { id } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [allRestaurants, setAllRestaurants] = useState<Restaurant[]>([]);
  const [selectedRestaurant, setSelectedRestaurant] = useState('');

  const load = () => {
    if (!id) return;
    api<Trip>(`/trips/${id}`).then(setTrip);
    api<Restaurant[]>('/restaurants').then(setAllRestaurants);
  };

  useEffect(() => { load(); }, [id]);

  const addRestaurant = async () => {
    if (!selectedRestaurant || !id) return;
    await api(`/trips/${id}/restaurants`, {
      method: 'POST',
      body: JSON.stringify({ restaurant_id: selectedRestaurant }),
    });
    setSelectedRestaurant('');
    load();
  };

  const removeRestaurant = async (restaurantId: string) => {
    if (!id) return;
    await api(`/trips/${id}/restaurants/${restaurantId}`, { method: 'DELETE' });
    load();
  };

  const formatDate = (d: string) => {
    try { return format(new Date(d), 'MMM d, yyyy'); } catch { return d; }
  };

  if (!trip) return <p className="text-gray-500">Loading...</p>;

  const tripRestaurantIds = new Set(trip.restaurants.map(r => r.id));
  const availableRestaurants = allRestaurants.filter(r => !tripRestaurantIds.has(r.id));

  return (
    <div>
      <Link to="/trips" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
        &larr; Back to trips
      </Link>

      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{trip.name}</h1>
            <p className="text-sm text-gray-500 mt-1">
              {formatDate(trip.start_date)} — {formatDate(trip.end_date)}
              {trip.city && <span className="ml-2">({trip.city})</span>}
            </p>
          </div>
          {trip.is_active ? (
            <span className="px-3 py-1 bg-blue-100 text-blue-800 text-xs font-medium rounded-full">Active</span>
          ) : null}
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

      {/* Restaurant list */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-medium text-gray-900">
            Restaurants ({trip.restaurants.length})
          </h2>
        </div>
        {trip.restaurants.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500 text-center">No restaurants added yet.</p>
        ) : (
          <div className="divide-y divide-gray-200">
            {trip.restaurants.map((r, idx) => (
              <div key={r.id} className="px-4 py-3 flex items-center justify-between hover:bg-gray-50">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-400 w-6 text-center">{idx + 1}</span>
                  <div>
                    <Link to={`/restaurants/${r.id}`} className="text-sm font-medium text-blue-600 hover:text-blue-800">
                      {r.is_favorite ? <span className="text-amber-400 mr-1">★</span> : null}{r.name}
                    </Link>
                    <div className="flex gap-2 mt-0.5">
                      {r.tabelog_score && (
                        <span className={`text-xs font-semibold ${
                          r.tabelog_score >= 4.0 ? 'text-red-600' :
                          r.tabelog_score >= 3.5 ? 'text-orange-500' : 'text-gray-500'
                        }`}>
                          {r.tabelog_score.toFixed(2)}
                        </span>
                      )}
                      {r.cuisine && <span className="text-xs text-gray-400">{r.cuisine}</span>}
                      {r.area && <span className="text-xs text-gray-400">{r.area}</span>}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => removeRestaurant(r.id)}
                  className="text-xs text-red-600 hover:text-red-800"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
