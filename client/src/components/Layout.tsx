import { Link, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Trip {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_active: number;
}

const navItems = [
  { path: '/restaurants', label: 'Restaurants' },
  { path: '/trips', label: 'Trips' },
  { path: '/accounts', label: 'Accounts' },
];

export default function Layout() {
  const location = useLocation();
  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);

  useEffect(() => {
    api<Trip[]>('/trips').then(trips => {
      const active = trips.find(t => t.is_active);
      setActiveTrip(active || null);
    }).catch(() => {});
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <Link to="/" className="px-6 py-5 text-lg font-bold text-gray-900 border-b border-gray-200">
          Japan Planner
        </Link>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(item => {
            const isActive = location.pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`block px-3 py-2 rounded-md text-sm font-medium ${
                  isActive
                    ? 'bg-gray-100 text-gray-900'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        {activeTrip && (
          <div className="px-4 py-3 border-t border-gray-200 bg-blue-50">
            <div className="text-xs font-medium text-blue-600 uppercase tracking-wide">Active Trip</div>
            <Link to={`/trips/${activeTrip.id}`} className="text-sm font-medium text-blue-900 hover:underline">
              {activeTrip.name}
            </Link>
            <div className="text-xs text-blue-700 mt-0.5">
              {activeTrip.start_date} — {activeTrip.end_date}
            </div>
          </div>
        )}
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
