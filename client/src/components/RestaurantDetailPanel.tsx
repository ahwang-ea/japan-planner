import { useEffect, useState, useRef } from 'react';
import type { Restaurant, TabelogResult } from '../pages/Restaurants';
import { api } from '../lib/api';

interface ReservationAvailability {
  tabelogUrl: string;
  hasOnlineReservation: boolean;
  reservationUrl: string | null;
  dates: { date: string; status: 'available' | 'limited' | 'unavailable' | 'unknown'; timeSlots: string[] }[];
  checkedAt: string;
  error?: string;
}

interface TabelogReview {
  author: string | null;
  rating: number | null;
  date: string | null;
  title: string | null;
  body: string;
  visitDate: string | null;
  mealType: string | null;
  priceRange: string | null;
  photos?: string[];
  reviewUrl?: string | null;
  photoCount?: number;
  title_en?: string | null;
  body_en?: string | null;
}

interface Props {
  restaurant: Restaurant | TabelogResult;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  onFavoriteToggle?: () => void;
  isFavorited?: boolean;
  isSaving?: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  favoriteAnimating?: boolean;
  availability?: ReservationAvailability | null;
  filterDateFrom?: string;
  filterDateTo?: string;
  filterMeals?: Set<'lunch' | 'dinner'>;
  filterPartySize?: number;
}

function isSavedRestaurant(r: Restaurant | TabelogResult): r is Restaurant {
  return 'id' in r;
}

export default function RestaurantDetailPanel({
  restaurant: r,
  onClose,
  onNext,
  onPrev,
  onFavoriteToggle,
  isFavorited,
  isSaving,
  hasPrev,
  hasNext,
  favoriteAnimating,
  availability: externalAvailability,
  filterDateFrom,
  filterDateTo,
  filterMeals,
  filterPartySize,
}: Props) {
  const saved = isSavedRestaurant(r) ? r : null;
  const [availability, setAvailability] = useState<ReservationAvailability | null>(externalAvailability ?? null);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const fetchedUrlRef = useRef<string | null>(null);

  // Photo state
  const [photos, setPhotos] = useState<string[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [showGallery, setShowGallery] = useState(false);
  const [photoCategory, setPhotoCategory] = useState('all');
  const [galleryPhotos, setGalleryPhotos] = useState<string[] | null>(null);

  // Review state
  const [reviews, setReviews] = useState<TabelogReview[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewCount, setReviewCount] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [expandedReview, setExpandedReview] = useState<TabelogReview | null>(null);
  const [modalPhotos, setModalPhotos] = useState<string[] | null>(null);
  const [modalPhotosLoading, setModalPhotosLoading] = useState(false);

  // Lazy-load full photos when review modal opens
  useEffect(() => {
    setModalPhotos(null);
    if (!expandedReview?.reviewUrl || !expandedReview.photoCount || expandedReview.photoCount <= (expandedReview.photos?.length || 0)) return;
    setModalPhotosLoading(true);
    const params = new URLSearchParams({ url: expandedReview.reviewUrl, body: expandedReview.body.slice(0, 40) });
    api<{ photos: string[] }>(`/restaurants/reviews/photos?${params}`)
      .then(data => setModalPhotos(data.photos))
      .catch(() => {})
      .finally(() => setModalPhotosLoading(false));
  }, [expandedReview]);

  // ESC closes modals before propagating to parent (which closes the panel)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showGallery) {
        e.stopPropagation();
        e.preventDefault();
        setShowGallery(false);
        setGalleryPhotos(null);
      } else if (expandedReview) {
        e.stopPropagation();
        e.preventDefault();
        setExpandedReview(null);
      }
    };
    window.addEventListener('keydown', handler, true); // capture phase
    return () => window.removeEventListener('keydown', handler, true);
  }, [showGallery, expandedReview]);

  // Auto-fetch availability when panel opens or restaurant changes
  useEffect(() => {
    if (externalAvailability) {
      setAvailability(externalAvailability);
      return;
    }
    const url = r.tabelog_url;
    if (!url || fetchedUrlRef.current === url) return;
    fetchedUrlRef.current = url;
    setLoadingAvail(true);
    api<ReservationAvailability>('/availability/check', {
      method: 'POST',
      body: JSON.stringify({ tabelog_url: url, dateFrom: filterDateFrom || undefined, dateTo: filterDateTo || undefined, meals: filterMeals && filterMeals.size > 0 ? [...filterMeals] : undefined, partySize: filterPartySize || undefined }),
    })
      .then(setAvailability)
      .catch(() => setAvailability(null))
      .finally(() => setLoadingAvail(false));
  }, [r.tabelog_url, externalAvailability, filterDateFrom, filterDateTo, filterMeals, filterPartySize]);

  // Reset when restaurant changes
  useEffect(() => {
    if (!externalAvailability) {
      setAvailability(null);
      fetchedUrlRef.current = null;
    }
  }, [r.tabelog_url]);

  // Reset photo category when restaurant changes
  useEffect(() => {
    setPhotoCategory('all');
  }, [r.tabelog_url]);

  // Auto-fetch photos when restaurant or category changes
  useEffect(() => {
    setPhotos([]);
    setPhotoIndex(0);
    setShowGallery(false);
    if (!r.tabelog_url) return;
    setPhotosLoading(true);
    const catParam = photoCategory !== 'all' ? `&category=${photoCategory}` : '';
    api<{ photos: string[]; totalCount: number }>(`/restaurants/photos?url=${encodeURIComponent(r.tabelog_url)}${catParam}`)
      .then(data => setPhotos(data.photos))
      .catch(() => {})
      .finally(() => setPhotosLoading(false));
  }, [r.tabelog_url, photoCategory]);

  // Auto-fetch reviews when restaurant changes (streaming NDJSON)
  useEffect(() => {
    setReviews([]);
    setReviewCount(0);
    setShowOriginal(false);
    const tabelogUrl = r.tabelog_url;
    if (!tabelogUrl) return;
    setReviewsLoading(true);
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/restaurants/reviews?url=${encodeURIComponent(tabelogUrl)}`, { signal: controller.signal });
        if (!res.ok || !res.body) throw new Error('Failed to fetch reviews');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            if (msg.type === 'page') {
              setReviews(prev => [...prev, ...msg.reviews]);
              if (msg.totalCount) setReviewCount(msg.totalCount);
            } else if (msg.type === 'translations') {
              // Merge translations into existing reviews by matching body text
              const translationMap = new Map<string, TabelogReview>();
              for (const t of msg.reviews as TabelogReview[]) {
                translationMap.set(t.body, t);
              }
              setReviews(prev => prev.map(rev => {
                const translated = translationMap.get(rev.body);
                return translated ? { ...rev, title_en: translated.title_en, body_en: translated.body_en } : rev;
              }));
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') console.error(e);
      } finally {
        setReviewsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [r.tabelog_url]);

  const scoreColor = (score: number | null) =>
    !score ? 'text-gray-400' :
    score >= 4.0 ? 'text-red-600' :
    score >= 3.5 ? 'text-orange-500' :
    'text-gray-600';

  const platformLinks = [
    { label: 'Tabelog', url: r.tabelog_url },
    { label: 'Omakase', url: saved?.omakase_url || ('omakase_url' in r ? r.omakase_url : null) },
    { label: 'TableCheck', url: saved?.tablecheck_url || ('tablecheck_url' in r ? r.tablecheck_url : null) },
    { label: 'TableAll', url: saved?.tableall_url || ('tableall_url' in r ? r.tableall_url : null) },
  ].filter(p => p.url);

  const formatCheckedAt = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
  };

  // Get the best reserve link — prefer the Japanese restaurant page (has embedded booking calendar)
  // over scraped yoyaku URLs that may point to broken endpoints like send_remind
  const getReserveUrl = () => {
    return availability?.tabelogUrl || r.tabelog_url?.replace('tabelog.com/en/', 'tabelog.com/') || r.tabelog_url || '#';
  };

  const statusSymbol = (s: string) => {
    switch (s) {
      case 'available': return { symbol: '◯', color: 'text-green-600 bg-green-50 border-green-200' };
      case 'limited': return { symbol: '△', color: 'text-yellow-600 bg-yellow-50 border-yellow-200' };
      case 'unavailable': return { symbol: '✕', color: 'text-red-500 bg-red-50 border-red-200' };
      default: return { symbol: '?', color: 'text-gray-400 bg-gray-50 border-gray-200' };
    }
  };

  const displayPhotos = photos.length > 0 ? photos : r.image_url ? [r.image_url] : [];
  // Gallery overlay can show either main photos or review-specific photos
  const activeGalleryPhotos = galleryPhotos || displayPhotos;

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between py-3 border-b border-gray-200">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
        >
          <span className="text-lg leading-none">&larr;</span>
          <span>Back</span>
          <kbd className="ml-1 px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-xs text-gray-400">Esc</kbd>
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={onPrev}
            disabled={!hasPrev}
            className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 text-gray-500"
            aria-label="Previous"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={onNext}
            disabled={!hasNext}
            className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 text-gray-500"
            aria-label="Next"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto py-6">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {/* Photo carousel */}
          {(displayPhotos.length > 0 || photosLoading) && (
            <div className="relative">
              {displayPhotos.length > 0 ? (
                <img
                  src={displayPhotos[photoIndex]}
                  alt={r.name || ''}
                  className={`w-full h-56 object-cover ${displayPhotos.length > 1 ? 'cursor-pointer' : ''}`}
                  onClick={() => { if (displayPhotos.length > 1) { setGalleryPhotos(null); setShowGallery(true); } }}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div className="w-full h-56 bg-gray-100 flex items-center justify-center">
                  <span className="inline-block w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              {displayPhotos.length > 1 && (
                <div className="absolute bottom-2 right-2 flex items-center gap-1">
                  <button
                    onClick={e => { e.stopPropagation(); setPhotoIndex(i => Math.max(0, i - 1)); }}
                    disabled={photoIndex === 0}
                    className="px-1.5 py-0.5 bg-black/50 text-white rounded text-xs hover:bg-black/70 disabled:opacity-30"
                  >&larr;</button>
                  <span className="px-2 py-0.5 bg-black/50 text-white rounded text-xs">
                    {photoIndex + 1} / {displayPhotos.length}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); setPhotoIndex(i => Math.min(displayPhotos.length - 1, i + 1)); }}
                    disabled={photoIndex === displayPhotos.length - 1}
                    className="px-1.5 py-0.5 bg-black/50 text-white rounded text-xs hover:bg-black/70 disabled:opacity-30"
                  >&rarr;</button>
                </div>
              )}
              {photosLoading && displayPhotos.length > 0 && (
                <div className="absolute top-2 right-2 px-2 py-1 bg-black/50 text-white rounded text-xs flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Loading photos...
                </div>
              )}
              {/* Photo category tabs */}
              {r.tabelog_url && (
                <div className="absolute top-2 left-2 flex gap-1">
                  {[
                    { key: 'all', label: 'All' },
                    { key: 'food', label: 'Food' },
                    { key: 'drinks', label: 'Drinks' },
                    { key: 'interior', label: 'Interior' },
                    { key: 'exterior', label: 'Exterior' },
                  ].map(cat => (
                    <button
                      key={cat.key}
                      onClick={e => { e.stopPropagation(); setPhotoCategory(cat.key); }}
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                        photoCategory === cat.key
                          ? 'bg-white text-gray-900 shadow'
                          : 'bg-black/40 text-white/80 hover:bg-black/60 hover:text-white'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="p-6">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                {onFavoriteToggle && (
                  <button
                    onClick={onFavoriteToggle}
                    disabled={isSaving}
                    className={`text-2xl leading-none inline-block ${isFavorited ? 'text-amber-400' : 'text-gray-300 hover:text-amber-300'} ${favoriteAnimating ? 'animate-favorite-pop' : ''} disabled:opacity-50`}
                    aria-label={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    {isFavorited ? '★' : '☆'}
                  </button>
                )}
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">{r.name || 'Unknown'}</h1>
                  {r.name_ja && <p className="text-gray-500 mt-1">{r.name_ja}</p>}
                  {onFavoriteToggle && (
                    <span className="text-xs text-gray-400 mt-1 inline-block">
                      Press <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">F</kbd> to {isFavorited ? 'unfavorite' : 'favorite'}
                    </span>
                  )}
                </div>
              </div>
              {r.tabelog_score && (
                <div className={`text-2xl font-bold ${scoreColor(r.tabelog_score)}`}>
                  {r.tabelog_score.toFixed(2)}
                </div>
              )}
            </div>

            {/* Info grid */}
            <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
              {r.cuisine && <Info label="Cuisine" value={r.cuisine} />}
              {r.area && <Info label="Area" value={r.area} />}
              {r.city && <Info label="City" value={r.city} />}
              {r.price_range && <Info label="Price Range" value={r.price_range} />}
              {saved?.address && <Info label="Address" value={saved.address} />}
              {saved?.phone && <Info label="Phone" value={saved.phone} />}
              {saved?.hours && <Info label="Hours" value={saved.hours} />}
            </div>

            {/* Platform links */}
            {platformLinks.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Links</h3>
                <div className="flex gap-2 flex-wrap">
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

            {/* Reservation Availability */}
            {r.tabelog_url && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Tabelog Reservation</h3>
                {loadingAvail ? (
                  <div className="flex items-center gap-2 text-sm text-gray-400">
                    <span className="inline-block w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    Checking availability on Japanese site...
                  </div>
                ) : availability ? (
                  <div>
                    {availability.hasOnlineReservation ? (
                      <div>
                        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                          Online booking available
                        </span>
                        {availability.hasOnlineReservation && (
                          <a
                            href={getReserveUrl()}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-2 inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                          >
                            Reserve on Tabelog &rarr;
                          </a>
                        )}
                        {availability.dates.length > 0 && (
                          <div className="mt-3 flex gap-1.5 flex-wrap">
                            {availability.dates.map(d => {
                              const { symbol, color } = statusSymbol(d.status);
                              const dateLabel = new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                              return (
                                <div
                                  key={d.date}
                                  className={`px-2 py-1.5 rounded border text-xs ${color}`}
                                  title={d.timeSlots.length > 0 ? `Available: ${d.timeSlots.join(', ')}` : undefined}
                                >
                                  <div className="font-medium text-center">{dateLabel}</div>
                                  <div className="text-center text-sm">{symbol}</div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
                        No online booking
                      </span>
                    )}
                    <p className="text-xs text-gray-400 mt-2">
                      Checked {formatCheckedAt(availability.checkedAt)}
                      {' '}
                      <a
                        href={availability.tabelogUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-600"
                      >
                        View JP page
                      </a>
                    </p>
                  </div>
                ) : (
                  <span className="text-xs text-gray-400">Unable to check availability</span>
                )}
              </div>
            )}

            {/* Reviews */}
            {r.tabelog_url && (
              <div className="mt-6">
                <h3 className="flex items-center gap-2 text-sm font-medium text-gray-700">
                  <span>Reviews{reviewCount > 0 ? ` (${reviewCount})` : ''}</span>
                  {reviewsLoading && (
                    <span className="inline-block w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  )}
                  {reviews.length > 0 && reviews.some(r => r.body_en) && (
                    <button
                      onClick={() => setShowOriginal(o => !o)}
                      className="ml-auto text-xs px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-100"
                    >
                      {showOriginal ? 'Show English' : 'Show Japanese'}
                    </button>
                  )}
                </h3>
                {reviews.length > 0 && (
                  <div className="mt-3 space-y-4 max-h-96 overflow-y-auto">
                    {reviews.map((review, i) => {
                      const bodyText = !showOriginal && review.body_en ? review.body_en : review.body;
                      const truncated = bodyText.length > 150;
                      return (
                        <div
                          key={i}
                          className="border-l-2 border-gray-200 pl-3 cursor-pointer hover:bg-gray-50 -ml-px rounded-r"
                          onClick={() => setExpandedReview(review)}
                        >
                          <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
                            {review.author && <span className="font-medium">{review.author}</span>}
                            {review.rating != null && (
                              <span className={`font-bold ${scoreColor(review.rating)}`}>
                                {review.rating.toFixed(1)}
                              </span>
                            )}
                            {review.visitDate && <span>{review.visitDate}</span>}
                            {review.mealType && (
                              <span className="px-1.5 py-0.5 bg-gray-100 rounded text-xs">{review.mealType}</span>
                            )}
                            {review.priceRange && <span>{review.priceRange}</span>}
                          </div>
                          {(review.title || review.title_en) && (
                            <p className="text-sm font-medium text-gray-800 mt-1">
                              {!showOriginal && review.title_en ? review.title_en : review.title}
                            </p>
                          )}
                          <p className="text-sm text-gray-600 mt-1">
                            {truncated ? bodyText.slice(0, 150) + '...' : bodyText}
                          </p>
                          {review.photos && review.photos.length > 0 && (
                            <div className="flex gap-1 mt-1.5">
                              {review.photos.slice(0, 3).map((photo, j) => (
                                <img key={j} src={photo} alt="" className="w-10 h-10 object-cover rounded flex-shrink-0" />
                              ))}
                              {(review.photoCount || review.photos.length) > 3 && (
                                <span className="text-xs text-gray-400 self-center ml-1">+more</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {!reviewsLoading && reviews.length === 0 && (
                  <p className="text-xs text-gray-400 mt-2">No reviews found</p>
                )}
              </div>
            )}

            {/* Notes (saved only) */}
            {saved?.notes && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-gray-700 mb-1">Notes</h3>
                <p className="text-sm text-gray-600 whitespace-pre-wrap">{saved.notes}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Keyboard hints footer */}
      <div className="py-2 border-t border-gray-100 flex items-center gap-4 text-xs text-gray-400">
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">j/k</kbd> prev/next</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">f</kbd> favorite</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">t</kbd> add to trip</span>
        <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">Esc</kbd> back to list</span>
      </div>

      {/* Review detail modal */}
      {expandedReview && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => setExpandedReview(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                {expandedReview.author && <span className="font-medium text-gray-700">{expandedReview.author}</span>}
                {expandedReview.rating != null && (
                  <span className={`font-bold ${scoreColor(expandedReview.rating)}`}>
                    {expandedReview.rating.toFixed(1)}
                  </span>
                )}
              </div>
              <button onClick={() => setExpandedReview(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
            </div>
            <div className="px-4 py-3 space-y-3">
              <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
                {expandedReview.visitDate && <span>{expandedReview.visitDate}</span>}
                {expandedReview.mealType && (
                  <span className="px-1.5 py-0.5 bg-gray-100 rounded">{expandedReview.mealType}</span>
                )}
                {expandedReview.priceRange && <span>{expandedReview.priceRange}</span>}
              </div>
              {(expandedReview.title || expandedReview.title_en) && (
                <p className="font-medium text-gray-900">
                  {!showOriginal && expandedReview.title_en ? expandedReview.title_en : expandedReview.title}
                </p>
              )}
              <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                {!showOriginal && expandedReview.body_en ? expandedReview.body_en : expandedReview.body}
              </p>
              {(() => {
                const photos = modalPhotos || expandedReview.photos || [];
                return photos.length > 0 ? (
                  <div>
                    {modalPhotosLoading && (
                      <p className="text-xs text-gray-400 mb-1.5">Loading all photos...</p>
                    )}
                    <div className="grid grid-cols-3 gap-1.5">
                      {photos.map((photo, j) => (
                        <img
                          key={j}
                          src={photo}
                          alt=""
                          className="w-full aspect-square object-cover rounded cursor-pointer hover:opacity-80"
                          onClick={() => {
                            setGalleryPhotos(photos);
                            setPhotoIndex(j);
                            setShowGallery(true);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Full-screen photo gallery overlay */}
      {showGallery && activeGalleryPhotos.length > 0 && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center"
          onClick={() => { setShowGallery(false); setGalleryPhotos(null); }}
        >
          <button
            onClick={() => { setShowGallery(false); setGalleryPhotos(null); }}
            className="absolute top-4 right-4 text-white/80 hover:text-white text-3xl leading-none z-10"
          >&times;</button>
          <div className="relative flex-1 flex items-center justify-center w-full px-16" onClick={e => e.stopPropagation()}>
            {photoIndex > 0 && (
              <button
                onClick={() => setPhotoIndex(i => i - 1)}
                className="absolute left-4 text-white/70 hover:text-white text-4xl"
              >&lsaquo;</button>
            )}
            <img
              src={activeGalleryPhotos[photoIndex]}
              className="max-w-full max-h-[80vh] object-contain"
              alt=""
            />
            {photoIndex < activeGalleryPhotos.length - 1 && (
              <button
                onClick={() => setPhotoIndex(i => i + 1)}
                className="absolute right-4 text-white/70 hover:text-white text-4xl"
              >&rsaquo;</button>
            )}
          </div>
          <div className="flex gap-1.5 py-4 overflow-x-auto max-w-full px-4" onClick={e => e.stopPropagation()}>
            {activeGalleryPhotos.map((p, i) => (
              <img
                key={i}
                src={p}
                onClick={() => setPhotoIndex(i)}
                className={`w-16 h-12 object-cover rounded cursor-pointer flex-shrink-0 ${i === photoIndex ? 'ring-2 ring-white' : 'opacity-50 hover:opacity-80'}`}
                alt=""
              />
            ))}
          </div>
          <div className="text-white/60 text-sm pb-4">{photoIndex + 1} / {activeGalleryPhotos.length}</div>
        </div>
      )}
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
