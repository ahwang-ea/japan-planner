import { useEffect, useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import RestaurantForm from '../components/RestaurantForm';

export interface Restaurant {
  id: string;
  name: string;
  name_ja: string | null;
  tabelog_url: string | null;
  tabelog_score: number | null;
  cuisine: string | null;
  area: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  price_range: string | null;
  hours: string | null;
  notes: string | null;
  rank: number | null;
  omakase_url: string | null;
  tablecheck_url: string | null;
  tableall_url: string | null;
  created_at: string;
  updated_at: string;
}

interface TabelogResult {
  name: string | null;
  name_ja: string | null;
  tabelog_url: string | null;
  tabelog_score: number | null;
  cuisine: string | null;
  area: string | null;
  city: string | null;
  price_range: string | null;
}

interface BrowseResponse {
  restaurants: TabelogResult[];
  page: number;
  hasNextPage: boolean;
}

type Tab = 'saved' | 'browse';

const CITIES = [
  'tokyo', 'osaka', 'kyoto', 'fukuoka', 'sapporo',
  'nagoya', 'yokohama', 'kobe', 'hiroshima', 'sendai',
  'nara', 'kanazawa',
];

export default function Restaurants() {
  const [tab, setTab] = useState<Tab>('browse');

  // Saved restaurants state
  const [saved, setSaved] = useState<Restaurant[]>([]);
  const [savedLoading, setSavedLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Browse state
  const [city, setCity] = useState('tokyo');
  const [browsePage, setBrowsePage] = useState(1);
  const [browseResults, setBrowseResults] = useState<TabelogResult[]>([]); // current page (no filter mode)
  const [allResults, setAllResults] = useState<TabelogResult[]>([]); // accumulated across pages (filter mode)
  const [lastFetchedPage, setLastFetchedPage] = useState(0);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [savedUrls, setSavedUrls] = useState<Set<string>>(new Set());
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [selectedCuisines, setSelectedCuisines] = useState<Set<string>>(new Set());
  const fetchingMoreRef = useRef(false);

  const MIN_FILTERED = 20;
  const MAX_PAGES = 10; // safety limit

  const loadSaved = () => {
    setSavedLoading(true);
    api<Restaurant[]>('/restaurants').then(r => {
      setSaved(r);
      setSavedUrls(new Set(r.map(x => x.tabelog_url).filter(Boolean) as string[]));
    }).finally(() => setSavedLoading(false));
  };

  useEffect(() => { loadSaved(); }, []);

  const browse = (c: string, p: number) => {
    setBrowseLoading(true);
    setBrowseResults([]);
    setAllResults([]);
    setLastFetchedPage(0);
    api<BrowseResponse>(`/restaurants/browse?city=${c}&page=${p}`)
      .then(r => {
        setBrowseResults(r.restaurants);
        setAllResults(r.restaurants);
        setHasNextPage(r.hasNextPage);
        setBrowsePage(r.page);
        setLastFetchedPage(r.page);
      })
      .catch(() => { setBrowseResults([]); setAllResults([]); })
      .finally(() => setBrowseLoading(false));
  };

  const fetchMorePages = useCallback(async () => {
    if (fetchingMoreRef.current || !hasNextPage) return;
    fetchingMoreRef.current = true;
    setFetchingMore(true);
    try {
      const nextPage = lastFetchedPage + 1;
      const r = await api<BrowseResponse>(`/restaurants/browse?city=${city}&page=${nextPage}`);
      setAllResults(prev => [...prev, ...r.restaurants]);
      setHasNextPage(r.hasNextPage);
      setLastFetchedPage(r.page);
    } finally {
      fetchingMoreRef.current = false;
      setFetchingMore(false);
    }
  }, [hasNextPage, lastFetchedPage, city]);

  const handleCityChange = (c: string) => {
    setCity(c);
    setBrowsePage(1);
    setSelectedCuisines(new Set());
    browse(c, 1);
  };

  // Navigate pages (no-filter mode): fetch a single page, but also keep it in allResults
  const goToPage = (p: number) => {
    setBrowseLoading(true);
    api<BrowseResponse>(`/restaurants/browse?city=${city}&page=${p}`)
      .then(r => {
        setBrowseResults(r.restaurants);
        setHasNextPage(r.hasNextPage);
        setBrowsePage(r.page);
        // Accumulate for when filters get toggled on later
        if (r.page > lastFetchedPage) {
          setAllResults(prev => [...prev, ...r.restaurants]);
          setLastFetchedPage(r.page);
        }
      })
      .catch(() => setBrowseResults([]))
      .finally(() => setBrowseLoading(false));
  };

  const isFiltering = selectedCuisines.size > 0;

  // Collect unique cuisines from ALL fetched results
  const availableCuisines = [...new Set(
    allResults.flatMap(r => r.cuisine ? r.cuisine.split(',').map(c => c.trim()) : []).filter(Boolean)
  )].sort();

  const toggleCuisine = (c: string) => {
    setSelectedCuisines(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const matchesCuisine = (r: TabelogResult) => {
    if (!r.cuisine) return false;
    const parts = r.cuisine.split(',').map(c => c.trim());
    return parts.some(p => selectedCuisines.has(p));
  };

  // When filtering: show matches from all accumulated results; otherwise show current page
  const filteredResults = isFiltering
    ? allResults.filter(matchesCuisine)
    : browseResults;

  // Auto-fetch more pages when filtering and not enough results
  useEffect(() => {
    if (isFiltering && filteredResults.length < MIN_FILTERED && hasNextPage && !fetchingMore && !browseLoading && lastFetchedPage < MAX_PAGES) {
      fetchMorePages();
    }
  }, [isFiltering, filteredResults.length, hasNextPage, fetchingMore, browseLoading, lastFetchedPage, fetchMorePages]);

  // Auto-browse on mount
  useEffect(() => { browse(city, 1); }, []);

  const handleSaveRestaurant = async (r: TabelogResult) => {
    if (!r.name) return;
    setSavingUrl(r.tabelog_url);
    try {
      await api('/restaurants', {
        method: 'POST',
        body: JSON.stringify({
          name: r.name,
          name_ja: r.name_ja,
          tabelog_url: r.tabelog_url,
          tabelog_score: r.tabelog_score,
          cuisine: r.cuisine,
          area: r.area,
          city: r.city || city,
          price_range: r.price_range,
        }),
      });
      loadSaved();
    } finally {
      setSavingUrl(null);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Remove "${name}" from your list?`)) return;
    await api(`/restaurants/${id}`, { method: 'DELETE' });
    loadSaved();
  };

  const handleSaved = () => {
    setShowForm(false);
    setEditingId(null);
    loadSaved();
  };

  const scoreColor = (score: number | null) =>
    !score ? 'text-gray-400' :
    score >= 4.0 ? 'text-red-600' :
    score >= 3.5 ? 'text-orange-500' :
    'text-gray-600';

  return (
    <div>
      {/* Tabs */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setTab('browse')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              tab === 'browse' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Browse Tabelog
          </button>
          <button
            onClick={() => setTab('saved')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              tab === 'saved' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            My List ({saved.length})
          </button>
        </div>
        {tab === 'saved' && (
          <button
            onClick={() => { setShowForm(true); setEditingId(null); }}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700"
          >
            Add Manually
          </button>
        )}
      </div>

      {/* Browse Tab */}
      {tab === 'browse' && (
        <div>
          {/* City filter */}
          <div className="mb-4 flex items-center gap-2 flex-wrap">
            {CITIES.map(c => (
              <button
                key={c}
                onClick={() => handleCityChange(c)}
                className={`px-3 py-1.5 text-sm rounded-full capitalize ${
                  c === city
                    ? 'bg-blue-600 text-white'
                    : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          {/* Cuisine filter */}
          {availableCuisines.length > 0 && !browseLoading && (
            <div className="mb-4 flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-gray-500 uppercase mr-1">Cuisine:</span>
              {selectedCuisines.size > 0 && (
                <button
                  onClick={() => setSelectedCuisines(new Set())}
                  className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 underline"
                >
                  Clear
                </button>
              )}
              {availableCuisines.map(c => (
                <button
                  key={c}
                  onClick={() => toggleCuisine(c)}
                  className={`px-2.5 py-1 text-xs rounded-full ${
                    selectedCuisines.has(c)
                      ? 'bg-purple-600 text-white'
                      : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {browseLoading ? (
            <div className="text-center py-12">
              <div className="inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
              <p className="mt-2 text-sm text-gray-500">Loading restaurants from Tabelog...</p>
              <p className="text-xs text-gray-400 mt-1">This may take a few seconds (scraping live data)</p>
            </div>
          ) : filteredResults.length === 0 && !fetchingMore ? (
            <p className="text-gray-500 text-center py-8">
              {allResults.length === 0 ? 'No results found. Try another city.' : 'No restaurants match the selected cuisines.'}
            </p>
          ) : (
            <>
              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-12">#</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Restaurant</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-20">Score</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Cuisine</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Area</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase w-24"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredResults.map((r, idx) => {
                      const isSaved = r.tabelog_url ? savedUrls.has(r.tabelog_url) : false;
                      const isSaving = savingUrl === r.tabelog_url;
                      return (
                        <tr key={r.tabelog_url || idx} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-400">
                            {isFiltering ? idx + 1 : (browsePage - 1) * 20 + idx + 1}
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-sm font-medium text-gray-900">{r.name || 'Unknown'}</div>
                            {r.tabelog_url && (
                              <a href={r.tabelog_url} target="_blank" rel="noopener noreferrer"
                                className="text-xs text-blue-500 hover:text-blue-700">
                                View on Tabelog
                              </a>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-sm font-semibold ${scoreColor(r.tabelog_score)}`}>
                              {r.tabelog_score?.toFixed(2) ?? '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">{r.cuisine || '—'}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{r.area || '—'}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{r.price_range || '—'}</td>
                          <td className="px-4 py-3 text-right">
                            {isSaved ? (
                              <span className="text-xs text-green-600 font-medium">Saved</span>
                            ) : (
                              <button
                                onClick={() => handleSaveRestaurant(r)}
                                disabled={isSaving}
                                className="px-3 py-1 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
                              >
                                {isSaving ? '...' : '+ Save'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination / Load more */}
              {isFiltering ? (
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-sm text-gray-500">
                    {filteredResults.length} matching from {allResults.length} restaurants ({lastFetchedPage} pages)
                  </span>
                  {fetchingMore && (
                    <span className="text-sm text-gray-400 flex items-center gap-2">
                      <span className="inline-block w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                      Loading more...
                    </span>
                  )}
                  {!fetchingMore && hasNextPage && lastFetchedPage < MAX_PAGES && (
                    <button
                      onClick={fetchMorePages}
                      className="px-4 py-2 text-sm bg-white border border-gray-200 rounded-md hover:bg-gray-50"
                    >
                      Load more pages
                    </button>
                  )}
                  {!hasNextPage && (
                    <span className="text-xs text-gray-400">All pages loaded</span>
                  )}
                </div>
              ) : (
                <div className="mt-4 flex items-center justify-between">
                  <button
                    onClick={() => goToPage(browsePage - 1)}
                    disabled={browsePage <= 1}
                    className="px-4 py-2 text-sm bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-gray-500">Page {browsePage}</span>
                  <button
                    onClick={() => goToPage(browsePage + 1)}
                    disabled={!hasNextPage}
                    className="px-4 py-2 text-sm bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Saved Tab */}
      {tab === 'saved' && (
        <div>
          {showForm && (
            <div className="mb-6 bg-white rounded-lg border border-gray-200 p-6">
              <RestaurantForm
                restaurantId={editingId}
                onSaved={handleSaved}
                onCancel={() => { setShowForm(false); setEditingId(null); }}
              />
            </div>
          )}

          {savedLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : saved.length === 0 ? (
            <p className="text-gray-500">No restaurants saved yet. Browse Tabelog to add some.</p>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">#</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Score</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Cuisine</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Area</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Platforms</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {saved.map((r, idx) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm text-gray-500">{r.rank ?? idx + 1}</td>
                      <td className="px-4 py-3">
                        <Link to={`/restaurants/${r.id}`} className="text-sm font-medium text-blue-600 hover:text-blue-800">
                          {r.name}
                        </Link>
                        {r.name_ja && <div className="text-xs text-gray-400">{r.name_ja}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-sm font-semibold ${scoreColor(r.tabelog_score)}`}>
                          {r.tabelog_score?.toFixed(2) ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{r.cuisine || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{r.area || r.city || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{r.price_range || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          {[
                            r.omakase_url && 'O',
                            r.tablecheck_url && 'TC',
                            r.tableall_url && 'TA',
                          ].filter(Boolean).map(p => (
                            <span key={p as string} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                              {p}
                            </span>
                          ))}
                          {!r.omakase_url && !r.tablecheck_url && !r.tableall_url && (
                            <span className="text-gray-400 text-sm">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button
                          onClick={() => { setEditingId(r.id); setShowForm(true); }}
                          className="text-sm text-gray-600 hover:text-gray-900"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(r.id, r.name)}
                          className="text-sm text-red-600 hover:text-red-800"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
