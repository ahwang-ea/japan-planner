import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { Restaurant } from './Restaurants';

export default function RestaurantDetail() {
  const { id } = useParams<{ id: string }>();
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);

  useEffect(() => {
    if (id) api<Restaurant>(`/restaurants/${id}`).then(setRestaurant);
  }, [id]);

  if (!restaurant) return <p className="text-gray-500">Loading...</p>;

  const platformLinks = [
    { label: 'Tabelog', url: restaurant.tabelog_url },
    { label: 'Omakase', url: restaurant.omakase_url },
    { label: 'TableCheck', url: restaurant.tablecheck_url },
    { label: 'TableAll', url: restaurant.tableall_url },
  ].filter(p => p.url);

  return (
    <div>
      <Link to="/restaurants" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
        &larr; Back to restaurants
      </Link>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{restaurant.name}</h1>
            {restaurant.name_ja && <p className="text-gray-500 mt-1">{restaurant.name_ja}</p>}
          </div>
          {restaurant.tabelog_score && (
            <div className={`text-2xl font-bold ${
              restaurant.tabelog_score >= 4.0 ? 'text-red-600' :
              restaurant.tabelog_score >= 3.5 ? 'text-orange-500' :
              'text-gray-600'
            }`}>
              {restaurant.tabelog_score.toFixed(2)}
            </div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          {restaurant.cuisine && <Info label="Cuisine" value={restaurant.cuisine} />}
          {restaurant.area && <Info label="Area" value={restaurant.area} />}
          {restaurant.city && <Info label="City" value={restaurant.city} />}
          {restaurant.price_range && <Info label="Price Range" value={restaurant.price_range} />}
          {restaurant.address && <Info label="Address" value={restaurant.address} />}
          {restaurant.phone && <Info label="Phone" value={restaurant.phone} />}
          {restaurant.hours && <Info label="Hours" value={restaurant.hours} />}
        </div>

        {platformLinks.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-700 mb-2">Booking Platforms</h3>
            <div className="flex gap-2">
              {platformLinks.map(p => (
                <a
                  key={p.label}
                  href={p.url!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
                >
                  {p.label} &rarr;
                </a>
              ))}
            </div>
          </div>
        )}

        {restaurant.notes && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-700 mb-1">Notes</h3>
            <p className="text-sm text-gray-600 whitespace-pre-wrap">{restaurant.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500">{label}:</span>{' '}
      <span className="text-gray-900">{value}</span>
    </div>
  );
}
