import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState, useMemo } from 'react';
import { api } from '../lib/api';
import { useCommandPalette, type Command } from '../hooks/useCommandPalette';
import { useGlobalKeyboard } from '../hooks/useGlobalKeyboard';
import CommandPalette from './CommandPalette';

interface Trip {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_active: number;
}

interface RestaurantSummary {
  id: string;
  name: string;
}

const navItems = [
  { path: '/restaurants', label: 'Restaurants', shortcut: 'g r' },
  { path: '/trips', label: 'Trips', shortcut: 'g t' },
  { path: '/accounts', label: 'Accounts', shortcut: 'g a' },
];

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [restaurants, setRestaurants] = useState<RestaurantSummary[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);

  useEffect(() => {
    api<Trip[]>('/trips').then(allTrips => {
      setTrips(allTrips);
      const active = allTrips.find(t => t.is_active);
      setActiveTrip(active || null);
    }).catch(() => {});
    api<RestaurantSummary[]>('/restaurants').then(setRestaurants).catch(() => {});
  }, [location.pathname]);

  const commands: Command[] = useMemo(() => [
    { id: 'nav-home', label: 'Go to Home', section: 'Navigation', keywords: ['home', 'welcome'], onSelect: () => navigate('/') },
    { id: 'nav-restaurants', label: 'Go to Restaurants', section: 'Navigation', keywords: ['food', 'tabelog', 'saved'], onSelect: () => navigate('/restaurants') },
    { id: 'nav-trips', label: 'Go to Trips', section: 'Navigation', keywords: ['trip', 'travel', 'plan'], onSelect: () => navigate('/trips') },
    { id: 'nav-accounts', label: 'Go to Accounts', section: 'Navigation', keywords: ['credentials', 'login', 'omakase', 'tablecheck'], onSelect: () => navigate('/accounts') },
    { id: 'action-new-trip', label: 'New Trip', section: 'Actions', keywords: ['create', 'add', 'trip'], onSelect: () => navigate('/trips?action=new') },
    { id: 'action-add-restaurant', label: 'Add Restaurant', section: 'Actions', keywords: ['create', 'save', 'new', 'restaurant'], onSelect: () => navigate('/restaurants?action=add') },
    { id: 'action-browse', label: 'Browse Tabelog', section: 'Actions', keywords: ['search', 'tabelog', 'browse', 'find'], onSelect: () => navigate('/restaurants') },
    { id: 'action-favorites', label: 'View Favorites', section: 'Actions', keywords: ['favorite', 'starred', 'priority'], onSelect: () => navigate('/restaurants?filter=favorites') },
    ...restaurants.map(r => ({
      id: `restaurant-${r.id}`,
      label: r.name,
      section: 'Restaurants',
      keywords: ['restaurant'],
      onSelect: () => navigate(`/restaurants/${r.id}`),
    })),
    ...trips.map(t => ({
      id: `trip-${t.id}`,
      label: t.name,
      section: 'Trips',
      keywords: ['trip'],
      onSelect: () => navigate(`/trips/${t.id}`),
    })),
  ], [restaurants, trips, navigate]);

  const palette = useCommandPalette(commands);
  useGlobalKeyboard(navigate, palette.open);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col" aria-label="Main navigation sidebar">
        <Link to="/" className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <span className="text-lg font-bold text-gray-900">Japan Planner</span>
          <kbd className="text-[10px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded border border-gray-200">g h</kbd>
        </Link>
        <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Main navigation">
          {navItems.map(item => {
            const isActive = location.pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium ${
                  isActive
                    ? 'bg-gray-100 text-gray-900'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
                aria-current={isActive ? 'page' : undefined}
              >
                {item.label}
                <kbd className="text-[10px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded border border-gray-200">{item.shortcut}</kbd>
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
        <div className="px-3 py-3 border-t border-gray-200">
          <button
            onClick={palette.open}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-400 rounded-md hover:bg-gray-50 hover:text-gray-600"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span>Search</span>
            <kbd className="ml-auto bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">&#8984;K</kbd>
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-y-auto" role="main">
        <Outlet />
      </main>
      {palette.isOpen && <CommandPalette {...palette} />}
    </div>
  );
}
