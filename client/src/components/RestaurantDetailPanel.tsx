import type { Restaurant, TabelogResult } from '../pages/Restaurants';

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
}: Props) {
  const saved = isSavedRestaurant(r) ? r : null;

  const scoreColor = (score: number | null) =>
    !score ? 'text-gray-400' :
    score >= 4.0 ? 'text-red-600' :
    score >= 3.5 ? 'text-orange-500' :
    'text-gray-600';

  const platformLinks = saved ? [
    { label: 'Tabelog', url: saved.tabelog_url },
    { label: 'Omakase', url: saved.omakase_url },
    { label: 'TableCheck', url: saved.tablecheck_url },
    { label: 'TableAll', url: saved.tableall_url },
  ].filter(p => p.url) : r.tabelog_url ? [{ label: 'Tabelog', url: r.tabelog_url }] : [];

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
          {r.image_url && (
            <img
              src={r.image_url}
              alt={r.name || ''}
              className="w-full h-56 object-cover"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
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
