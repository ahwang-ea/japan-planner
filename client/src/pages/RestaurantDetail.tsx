import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { isInputFocused } from '../lib/keyboard';
import type { Restaurant } from './Restaurants';

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
}

export default function RestaurantDetail() {
  const { id } = useParams<{ id: string }>();
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);

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

  const load = () => {
    if (id) api<Restaurant>(`/restaurants/${id}`).then(setRestaurant);
  };

  useEffect(() => { load(); }, [id]);

  // Reset photo category when restaurant changes
  useEffect(() => {
    setPhotoCategory('all');
  }, [restaurant?.tabelog_url]);

  // Fetch photos when restaurant loads or category changes
  useEffect(() => {
    setPhotos([]);
    setPhotoIndex(0);
    setShowGallery(false);
    if (!restaurant?.tabelog_url) return;
    setPhotosLoading(true);
    const catParam = photoCategory !== 'all' ? `&category=${photoCategory}` : '';
    api<{ photos: string[]; totalCount: number }>(`/restaurants/photos?url=${encodeURIComponent(restaurant.tabelog_url)}${catParam}`)
      .then(data => setPhotos(data.photos))
      .catch(() => {})
      .finally(() => setPhotosLoading(false));
  }, [restaurant?.tabelog_url, photoCategory]);

  // Auto-fetch reviews when restaurant changes
  useEffect(() => {
    setReviews([]);
    setReviewCount(0);
    if (!restaurant?.tabelog_url) return;
    setReviewsLoading(true);
    api<{ reviews: TabelogReview[]; totalCount: number }>(`/restaurants/reviews?url=${encodeURIComponent(restaurant.tabelog_url)}`)
      .then(data => {
        setReviews(data.reviews);
        setReviewCount(data.totalCount);
      })
      .catch(() => {})
      .finally(() => setReviewsLoading(false));
  }, [restaurant?.tabelog_url]);

  const toggleFavorite = async () => {
    if (!id) return;
    await api(`/restaurants/${id}/favorite`, { method: 'PATCH' });
    load();
  };

  // 'f' key to toggle favorite
  useEffect(() => {
    if (!restaurant) return;
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f') {
        e.preventDefault();
        toggleFavorite();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [restaurant, id]);

  if (!restaurant) return <p className="text-gray-500">Loading...</p>;

  const platformLinks = [
    { label: 'Tabelog', url: restaurant.tabelog_url },
    { label: 'Omakase', url: restaurant.omakase_url },
    { label: 'TableCheck', url: restaurant.tablecheck_url },
    { label: 'TableAll', url: restaurant.tableall_url },
  ].filter(p => p.url);

  const scoreColor = (score: number | null) =>
    !score ? 'text-gray-400' :
    score >= 4.0 ? 'text-red-600' :
    score >= 3.5 ? 'text-orange-500' :
    'text-gray-600';

  const displayPhotos = photos.length > 0 ? photos : restaurant.image_url ? [restaurant.image_url] : [];
  const activeGalleryPhotos = galleryPhotos || displayPhotos;

  return (
    <div>
      <Link to="/restaurants" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
        &larr; Back to restaurants
      </Link>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {/* Photo carousel */}
        {(displayPhotos.length > 0 || photosLoading) && (
          <div className="relative">
            {displayPhotos.length > 0 ? (
              <img
                src={displayPhotos[photoIndex]}
                alt={restaurant.name}
                className={`w-full h-48 object-cover ${displayPhotos.length > 1 ? 'cursor-pointer' : ''}`}
                onClick={() => { if (displayPhotos.length > 1) { setGalleryPhotos(null); setShowGallery(true); } }}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="w-full h-48 bg-gray-100 flex items-center justify-center">
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
            {restaurant.tabelog_url && (
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
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={toggleFavorite}
              className={`text-2xl leading-none ${restaurant.is_favorite ? 'text-amber-400' : 'text-gray-300 hover:text-amber-300'}`}
              aria-label={restaurant.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              {restaurant.is_favorite ? '★' : '☆'}
            </button>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{restaurant.name}</h1>
              {restaurant.name_ja && <p className="text-gray-500 mt-1">{restaurant.name_ja}</p>}
              <span className="text-xs text-gray-400 mt-1 inline-block">
                Press <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">F</kbd> to {restaurant.is_favorite ? 'unfavorite' : 'favorite'}
              </span>
            </div>
          </div>
          {restaurant.tabelog_score && (
            <div className={`text-2xl font-bold ${scoreColor(restaurant.tabelog_score)}`}>
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

        {/* Reviews */}
        {restaurant.tabelog_url && (
          <div className="mt-6">
            <h3 className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <span>Reviews{reviewCount > 0 ? ` (${reviewCount})` : ''}</span>
              {reviewsLoading && (
                <span className="inline-block w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
              )}
            </h3>
            {reviews.length > 0 && (
              <div className="mt-3 space-y-4 max-h-[32rem] overflow-y-auto">
                {reviews.map((review, i) => (
                  <div key={i} className="border-l-2 border-gray-200 pl-3">
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
                    {review.title && (
                      <p className="text-sm font-medium text-gray-800 mt-1">{review.title}</p>
                    )}
                    <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{review.body}</p>
                    {review.photos && review.photos.length > 0 && (
                      <div className="flex gap-1.5 mt-2 overflow-x-auto">
                        {review.photos.map((photo, j) => (
                          <img
                            key={j}
                            src={photo}
                            alt=""
                            className="w-20 h-20 object-cover rounded cursor-pointer flex-shrink-0 hover:opacity-80"
                            onClick={() => {
                              setGalleryPhotos(review.photos!);
                              setPhotoIndex(j);
                              setShowGallery(true);
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {!reviewsLoading && reviews.length === 0 && (
              <p className="text-xs text-gray-400 mt-2">No reviews found</p>
            )}
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
