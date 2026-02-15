import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { isInputFocused } from '../lib/keyboard';
import RestaurantForm from '../components/RestaurantForm';
import RestaurantDetailPanel from '../components/RestaurantDetailPanel';
import AddToTripModal from '../components/AddToTripModal';
import { CITIES } from '../lib/constants';

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
  image_url: string | null;
  is_favorite: number;
  created_at: string;
  updated_at: string;
}

export interface TabelogResult {
  name: string | null;
  name_ja: string | null;
  tabelog_url: string | null;
  tabelog_score: number | null;
  cuisine: string | null;
  area: string | null;
  city: string | null;
  price_range: string | null;
  image_url: string | null;
}

interface BrowseResponse {
  restaurants: TabelogResult[];
  page: number;
  hasNextPage: boolean;
}

type Tab = 'saved' | 'browse';


export default function Restaurants() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('browse');
  const [selectedRowIndex, setSelectedRowIndex] = useState(0);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);

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
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [favoriteUrls, setFavoriteUrls] = useState<Set<string>>(new Set());
  const [animatingFavorite, setAnimatingFavorite] = useState<string | null>(null);
  const [showTripModal, setShowTripModal] = useState(false);
  const fetchingMoreRef = useRef(false);

  const MIN_FILTERED = 20;
  const MAX_PAGES = 10; // safety limit

  const loadSaved = () => {
    setSavedLoading(true);
    api<Restaurant[]>('/restaurants').then(r => {
      setSaved(r);
      setSavedUrls(new Set(r.map(x => x.tabelog_url).filter(Boolean) as string[]));
      setFavoriteUrls(new Set(r.filter(x => x.is_favorite).map(x => x.tabelog_url).filter(Boolean) as string[]));
    }).finally(() => setSavedLoading(false));
  };

  useEffect(() => { loadSaved(); }, []);

  // Handle URL params from command palette
  useEffect(() => {
    if (searchParams.get('action') === 'add') {
      setTab('saved');
      setShowForm(true);
      setEditingId(null);
      setSearchParams({}, { replace: true });
    }
    if (searchParams.get('filter') === 'favorites') {
      setTab('saved');
      setShowFavoritesOnly(true);
      setSearchParams({}, { replace: true });
    }
    if (searchParams.get('tab') === 'browse') {
      setTab('browse');
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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

  const triggerFavoriteAnimation = (key: string) => {
    setAnimatingFavorite(key);
    setTimeout(() => setAnimatingFavorite(null), 500);
  };

  const toggleFavorite = async (id: string) => {
    triggerFavoriteAnimation(id);
    await api(`/restaurants/${id}/favorite`, { method: 'PATCH' });
    loadSaved();
  };

  // Save a browse result and immediately favorite it
  const saveAndFavorite = async (r: TabelogResult) => {
    if (!r.name) return;
    setSavingUrl(r.tabelog_url);
    if (r.tabelog_url) triggerFavoriteAnimation(r.tabelog_url);
    try {
      const created = await api<Restaurant>('/restaurants', {
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
          image_url: r.image_url,
        }),
      });
      if (created?.id) {
        await api(`/restaurants/${created.id}/favorite`, { method: 'PATCH' });
      }
      loadSaved();
    } finally {
      setSavingUrl(null);
    }
  };

  const displayedSaved = useMemo(
    () => showFavoritesOnly ? saved.filter(r => r.is_favorite) : saved,
    [saved, showFavoritesOnly],
  );

  // Current list for keyboard navigation (works across both tabs)
  const currentList: (Restaurant | TabelogResult)[] = tab === 'saved' ? displayedSaved : filteredResults;

  // Reset selection when switching tabs or when list changes
  useEffect(() => {
    setSelectedRowIndex(0);
    setDetailIndex(null);
  }, [tab]);

  // Clamp selection when list changes
  useEffect(() => {
    setSelectedRowIndex(i => {
      if (currentList.length === 0) return 0;
      if (i >= currentList.length) return currentList.length - 1;
      return i;
    });
  }, [currentList.length]);

  // Unified keyboard nav (both tabs, list + detail panel)
  useEffect(() => {
    if (showForm) return;
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      const maxIdx = currentList.length - 1;

      if (detailIndex !== null) {
        // Detail panel is open
        if (key === 'Escape') { e.preventDefault(); setDetailIndex(null); }
        else if (key === 'j' || key === 'ArrowDown') {
          e.preventDefault();
          setDetailIndex(i => Math.min((i ?? 0) + 1, maxIdx));
          setSelectedRowIndex(i => Math.min(i + 1, maxIdx));
        } else if (key === 'k' || key === 'ArrowUp') {
          e.preventDefault();
          setDetailIndex(i => Math.max((i ?? 0) - 1, 0));
          setSelectedRowIndex(i => Math.max(i - 1, 0));
        } else if (key === 'f') {
          e.preventDefault();
          const r = currentList[detailIndex];
          if (r && 'id' in r) {
            toggleFavorite(r.id);
          } else if (r && r.tabelog_url) {
            const match = saved.find(s => s.tabelog_url === r.tabelog_url);
            if (match) toggleFavorite(match.id);
            else saveAndFavorite(r as TabelogResult);
          }
        } else if (key === 't') {
          e.preventDefault();
          setShowTripModal(true);
        }
        return;
      }

      // List view
      if (key === 'j' || key === 'ArrowDown') {
        e.preventDefault();
        setSelectedRowIndex(i => Math.min(i + 1, maxIdx));
      } else if (key === 'k' || key === 'ArrowUp') {
        e.preventDefault();
        setSelectedRowIndex(i => Math.max(i - 1, 0));
      } else if (key === 'f' && selectedRowIndex >= 0 && selectedRowIndex < currentList.length) {
        e.preventDefault();
        const r = currentList[selectedRowIndex];
        if (r && 'id' in r) {
          toggleFavorite(r.id);
        } else if (r && r.tabelog_url) {
          const match = saved.find(s => s.tabelog_url === r.tabelog_url);
          if (match) toggleFavorite(match.id);
          else saveAndFavorite(r as TabelogResult);
        }
      } else if (key === 'Enter' && selectedRowIndex >= 0 && selectedRowIndex < currentList.length) {
        e.preventDefault();
        setDetailIndex(selectedRowIndex);
      } else if (key === 't' && selectedRowIndex >= 0 && selectedRowIndex < currentList.length) {
        e.preventDefault();
        setShowTripModal(true);
      } else if (key === 'Escape') {
        e.preventDefault();
        setSelectedRowIndex(0);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tab, currentList, selectedRowIndex, detailIndex, showForm, navigate, saved]);

  // Scroll selected row into view (only when list view is showing)
  useEffect(() => {
    if (selectedRowIndex < 0 || detailIndex !== null) return;
    document.querySelector(`[data-row-index="${selectedRowIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedRowIndex, detailIndex]);

  const scoreColor = (score: number | null) =>
    !score ? 'text-gray-400' :
    score >= 4.0 ? 'text-red-600' :
    score >= 3.5 ? 'text-orange-500' :
    'text-gray-600';

  return (
    <div>
      {/* Tabs */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'browse'}
            onClick={() => setTab('browse')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              tab === 'browse' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Browse Tabelog
            <kbd className="ml-1.5 text-[10px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded border border-gray-200">g b</kbd>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'saved'}
            onClick={() => setTab('saved')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              tab === 'saved' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Favorites ({saved.length})
            <kbd className="ml-1.5 text-[10px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded border border-gray-200">g f</kbd>
          </button>
        </div>
        {tab === 'saved' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFavoritesOnly(f => !f)}
              className={`px-3 py-2 text-sm font-medium rounded-md ${
                showFavoritesOnly
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {showFavoritesOnly ? '★ Favorites' : '☆ Favorites'}
              <kbd className="ml-1.5 text-[10px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded border border-gray-200">g f</kbd>
            </button>
            <button
              onClick={() => { setShowForm(true); setEditingId(null); }}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700"
            >
              Add Manually
            </button>
          </div>
        )}
      </div>

      {/* Detail Panel (replaces table when open) */}
      {detailIndex !== null && currentList[detailIndex] ? (
        <RestaurantDetailPanel
          restaurant={currentList[detailIndex]}
          onClose={() => setDetailIndex(null)}
          onNext={() => {
            if (detailIndex < currentList.length - 1) {
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
          hasNext={detailIndex < currentList.length - 1}
          onFavoriteToggle={() => {
            const item = currentList[detailIndex];
            if (!item) return;
            if ('id' in item) {
              toggleFavorite((item as Restaurant).id);
            } else if (item.tabelog_url) {
              const match = saved.find(s => s.tabelog_url === item.tabelog_url);
              if (match) toggleFavorite(match.id);
              else saveAndFavorite(item as TabelogResult);
            }
          }}
          isFavorited={(() => {
            const item = currentList[detailIndex];
            if (!item) return false;
            return 'id' in item
              ? !!(item as Restaurant).is_favorite
              : !!(item.tabelog_url && favoriteUrls.has(item.tabelog_url));
          })()}
          isSaving={savingUrl === currentList[detailIndex]?.tabelog_url}
          favoriteAnimating={(() => {
            const item = currentList[detailIndex];
            if (!item || !animatingFavorite) return false;
            return ('id' in item && animatingFavorite === (item as Restaurant).id) ||
              (item.tabelog_url === animatingFavorite);
          })()}
        />
      ) : (
        <>
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
                          const isItemSaved = r.tabelog_url ? savedUrls.has(r.tabelog_url) : false;
                          const isSaving = savingUrl === r.tabelog_url;
                          return (
                            <tr
                              key={r.tabelog_url || idx}
                              data-row-index={idx}
                              className={`cursor-pointer ${idx === selectedRowIndex ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' : 'hover:bg-gray-50'}`}
                              onClick={() => { setSelectedRowIndex(idx); setDetailIndex(idx); }}
                            >
                              <td className="px-4 py-3 text-sm text-gray-400">
                                {isFiltering ? idx + 1 : (browsePage - 1) * 20 + idx + 1}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-3">
                                  {r.image_url && (
                                    <img src={r.image_url} alt="" className="w-10 h-10 rounded object-cover shrink-0"
                                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                  )}
                                  <div>
                                    <div className="text-sm font-medium text-gray-900">{r.name || 'Unknown'}</div>
                                    {r.tabelog_url && (
                                      <a href={r.tabelog_url} target="_blank" rel="noopener noreferrer"
                                        onClick={e => e.stopPropagation()}
                                        className="text-xs text-blue-500 hover:text-blue-700">
                                        View on Tabelog
                                      </a>
                                    )}
                                  </div>
                                </div>
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
                                {(() => {
                                  const isFav = r.tabelog_url && favoriteUrls.has(r.tabelog_url);
                                  const isAnimating = (r.tabelog_url && animatingFavorite === r.tabelog_url) || (r.tabelog_url && saved.find(s => s.tabelog_url === r.tabelog_url)?.id === animatingFavorite);
                                  return (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (isItemSaved) {
                                          const match = saved.find(s => s.tabelog_url === r.tabelog_url);
                                          if (match) toggleFavorite(match.id);
                                        } else {
                                          saveAndFavorite(r);
                                        }
                                      }}
                                      disabled={isSaving}
                                      className={`inline-flex items-center px-3 py-1 text-xs font-medium rounded-md ${isAnimating ? 'animate-favorite-pop' : ''} ${
                                        isFav
                                          ? 'bg-amber-50 text-amber-600 border border-amber-200 hover:bg-amber-100'
                                          : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200'
                                      } disabled:opacity-50`}
                                    >
                                      {isSaving ? '...' : isFav ? '★ Favorited' : '☆ Favorite'}
                                    </button>
                                  );
                                })()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 flex items-center gap-4 text-xs text-gray-400">
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">j/k</kbd> navigate</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">f</kbd> favorite</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Enter</kbd> view</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">t</kbd> add to trip</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Esc</kbd> deselect</span>
                      <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">g f</kbd> view favorites</span>
                    </div>
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
                        <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase w-10"></th>
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
                      {displayedSaved.map((r, idx) => (
                        <tr
                          key={r.id}
                          data-row-index={idx}
                          className={`cursor-pointer ${idx === selectedRowIndex ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' : 'hover:bg-gray-50'}`}
                          onClick={() => { setSelectedRowIndex(idx); setDetailIndex(idx); }}
                        >
                          <td className="px-2 py-3 text-center">
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleFavorite(r.id); }}
                              className={`text-lg leading-none inline-block ${r.is_favorite ? 'text-amber-400' : 'text-gray-300 hover:text-amber-300'} ${animatingFavorite === r.id ? 'animate-favorite-pop' : ''}`}
                              aria-label={r.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                            >
                              {r.is_favorite ? '★' : '☆'}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">{r.rank ?? idx + 1}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              {r.image_url && (
                                <img src={r.image_url} alt="" className="w-10 h-10 rounded object-cover shrink-0"
                                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              )}
                              <div>
                                <span className="text-sm font-medium text-blue-600">
                                  {r.name}
                                </span>
                                {r.name_ja && <div className="text-xs text-gray-400">{r.name_ja}</div>}
                              </div>
                            </div>
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
                              onClick={(e) => { e.stopPropagation(); setEditingId(r.id); setShowForm(true); }}
                              className="text-sm text-gray-600 hover:text-gray-900"
                            >
                              Edit
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(r.id, r.name); }}
                              className="text-sm text-red-600 hover:text-red-800"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 flex items-center gap-4 text-xs text-gray-400">
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">j/k</kbd> navigate</span>
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">f</kbd> favorite</span>
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Enter</kbd> view</span>
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">t</kbd> add to trip</span>
                    <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">g f</kbd> view favorites</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {showTripModal && (() => {
        const idx = detailIndex ?? selectedRowIndex;
        const r = currentList[idx];
        if (!r) return null;
        return (
          <AddToTripModal
            restaurant={r}
            city={city}
            onClose={() => setShowTripModal(false)}
            onAdded={() => { setShowTripModal(false); loadSaved(); }}
          />
        );
      })()}
    </div>
  );
}
