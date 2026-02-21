import type { TabelogResult, Restaurant } from '../pages/Restaurants';

const scoreColor = (score: number | null) =>
  !score ? 'text-gray-400' :
  score >= 4.0 ? 'text-red-600' :
  score >= 3.5 ? 'text-orange-500' :
  'text-gray-600';

interface RestaurantCardProps {
  restaurant: TabelogResult | Restaurant;
  index: number;
  isSelected: boolean;
  isFavorited: boolean;
  isInTrip: boolean;
  onSelect: () => void;
  onFavorite: () => void;
}

export default function RestaurantCard({ restaurant: r, isSelected, isFavorited, isInTrip, onSelect, onFavorite }: RestaurantCardProps) {
  return (
    <div
      onClick={onSelect}
      className={`bg-white rounded-lg border p-3 flex gap-3 active:bg-gray-50 ${
        isSelected ? 'ring-1 ring-blue-200 border-blue-200 bg-blue-50/50' : 'border-gray-200'
      }`}
    >
      {r.image_url && (
        <img
          src={r.image_url}
          alt=""
          className="w-14 h-14 rounded-lg object-cover shrink-0"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {isInTrip && <span className="text-teal-500 text-[10px]">●</span>}
          <span className="text-sm font-medium text-gray-900 truncate">{r.name || 'Unknown'}</span>
          {r.tablecheck_url && <span className="text-[10px] font-semibold text-teal-700 bg-teal-50 px-1 rounded shrink-0">TC</span>}
          {r.tableall_url && <span className="text-[10px] font-semibold text-purple-700 bg-purple-50 px-1 rounded shrink-0">TA</span>}
          {r.omakase_url && <span className="text-[10px] font-semibold text-pink-700 bg-pink-50 px-1 rounded shrink-0">OM</span>}
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
          {r.tabelog_score && (
            <span className={`font-semibold ${scoreColor(r.tabelog_score)}`}>
              {r.tabelog_score.toFixed(2)}
            </span>
          )}
          {r.cuisine && <span className="truncate">{r.cuisine}</span>}
          {r.area && <span className="text-gray-400 truncate">{r.area}</span>}
        </div>
        {r.price_range && <div className="text-xs text-gray-400 mt-0.5">{r.price_range}</div>}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onFavorite(); }}
        className={`self-center p-2 text-lg leading-none shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center ${isFavorited ? 'text-amber-400' : 'text-gray-300'}`}
      >
        {isFavorited ? '★' : '☆'}
      </button>
    </div>
  );
}
