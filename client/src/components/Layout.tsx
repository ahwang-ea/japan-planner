import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState, useMemo } from 'react';
import { api } from '../lib/api';
import { useCommandPalette, type Command } from '../hooks/useCommandPalette';
import { useGlobalKeyboard } from '../hooks/useGlobalKeyboard';
import { useIsMobile } from '../hooks/useIsMobile';
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
    { id: 'nav-home', label: 'Go to Home', section: 'Navigation', keywords: ['home', 'welcome'], onSelect: () => navigate('/restaurants') },
    { id: 'nav-restaurants', label: 'Go to Restaurants', section: 'Navigation', keywords: ['food', 'tabelog', 'saved'], onSelect: () => navigate('/restaurants') },
    { id: 'nav-trips', label: 'Go to Trips', section: 'Navigation', keywords: ['trip', 'travel', 'plan'], onSelect: () => navigate('/trips') },
    { id: 'nav-accounts', label: 'Go to Accounts', section: 'Navigation', keywords: ['credentials', 'login', 'omakase', 'tablecheck'], onSelect: () => navigate('/accounts') },
    { id: 'action-new-trip', label: 'New Trip', section: 'Actions', keywords: ['create', 'add', 'trip'], onSelect: () => navigate('/trips?action=new') },
    { id: 'action-add-restaurant', label: 'Add Restaurant', section: 'Actions', keywords: ['create', 'save', 'new', 'restaurant'], onSelect: () => navigate('/restaurants?action=add') },
    { id: 'action-browse', label: 'Browse Tabelog', section: 'Actions', keywords: ['search', 'tabelog', 'browse', 'find'], onSelect: () => navigate('/restaurants') },
    { id: 'action-favorites', label: 'View Favorites', section: 'Actions', keywords: ['favorite', 'starred', 'priority'], onSelect: () => navigate('/restaurants?filter=favorites') },
    { id: 'action-discover-platforms', label: 'Discover Booking Platforms', section: 'Actions', keywords: ['discover', 'platform', 'tablecheck', 'omakase', 'tableall', 'booking', 'reserve', 'phone'], onSelect: () => navigate('/restaurants?action=discover-platforms&tab=browse') },
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
  const isMobile = useIsMobile();

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Desktop sidebar — hidden on mobile */}
      <aside className="hidden md:flex w-56 bg-white border-r border-gray-200 flex-col" aria-label="Main navigation sidebar">
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

      <div className="flex-1 flex flex-col min-h-0">
        {/* Mobile top bar */}
        {isMobile && (
          <header className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200 shrink-0">
            <span className="text-lg font-bold text-gray-900">Japan Planner</span>
            <button onClick={palette.open} className="p-2 -mr-2 text-gray-500 active:text-gray-700">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          </header>
        )}

        <main className={`flex-1 overflow-y-auto ${isMobile ? 'px-4 py-4 pb-20' : 'p-8'}`} role="main">
          <Outlet />
        </main>

        {/* Mobile bottom tab bar */}
        {isMobile && (
          <nav
            className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex z-40"
            style={{ paddingBottom: 'var(--safe-bottom, 0px)' }}
          >
            {navItems.map(item => {
              const isActive = location.pathname.startsWith(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex-1 flex flex-col items-center py-2.5 text-[11px] font-medium ${
                    isActive ? 'text-blue-600' : 'text-gray-400'
                  }`}
                >
                  <TabIcon path={item.path} active={isActive} />
                  <span className="mt-1">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        )}
      </div>

      {palette.isOpen && <CommandPalette {...palette} />}
    </div>
  );
}

function TabIcon({ path, active }: { path: string; active: boolean }) {
  const color = active ? 'currentColor' : 'currentColor';
  const cls = `w-5 h-5`;
  switch (path) {
    case '/restaurants':
      return (
        <svg className={cls} fill="none" stroke={color} viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25v-1.5m0 1.5c-1.355 0-2.697.056-4.024.166C6.845 8.51 6 9.473 6 10.608v2.513m6-4.871c1.355 0 2.697.056 4.024.166C17.155 8.51 18 9.473 18 10.608v2.513M15 8.25v-1.5m-6 1.5v-1.5m12 9.75l-1.5.75a3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0 3.354 3.354 0 00-3 0 3.354 3.354 0 01-3 0L3 16.5m15-3.379a48.474 48.474 0 00-6-.371c-2.032 0-4.034.126-6 .371m12 0c.39.049.777.102 1.163.16 1.07.16 1.837 1.094 1.837 2.175v5.169c0 .621-.504 1.125-1.125 1.125H4.125A1.125 1.125 0 013 20.625v-5.17c0-1.08.768-2.014 1.837-2.174A47.78 47.78 0 016 13.12M12.265 3.11a.375.375 0 11-.53 0L12 2.845l.265.265zm-3 0a.375.375 0 11-.53 0L9 2.845l.265.265zm6 0a.375.375 0 11-.53 0L15 2.845l.265.265z" />
        </svg>
      );
    case '/trips':
      return (
        <svg className={cls} fill="none" stroke={color} viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
        </svg>
      );
    case '/accounts':
      return (
        <svg className={cls} fill="none" stroke={color} viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
        </svg>
      );
    default:
      return null;
  }
}
