import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Props {
  restaurantId?: string | null;
  onSaved: () => void;
  onCancel: () => void;
}

interface ScrapedData {
  name?: string;
  name_ja?: string;
  tabelog_score?: number;
  cuisine?: string;
  area?: string;
  city?: string;
  address?: string;
  phone?: string;
  price_range?: string;
  hours?: string;
}

const emptyForm = {
  name: '',
  name_ja: '',
  tabelog_url: '',
  tabelog_score: '',
  cuisine: '',
  area: '',
  city: '',
  address: '',
  phone: '',
  price_range: '',
  hours: '',
  notes: '',
  rank: '',
  omakase_url: '',
  tablecheck_url: '',
  tableall_url: '',
};

export default function RestaurantForm({ restaurantId, onSaved, onCancel }: Props) {
  const [form, setForm] = useState(emptyForm);
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scraping, setScraping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isEdit = !!restaurantId;

  useEffect(() => {
    if (restaurantId) {
      api<Record<string, unknown>>(`/restaurants/${restaurantId}`).then(r => {
        setForm({
          name: (r.name as string) || '',
          name_ja: (r.name_ja as string) || '',
          tabelog_url: (r.tabelog_url as string) || '',
          tabelog_score: r.tabelog_score != null ? String(r.tabelog_score) : '',
          cuisine: (r.cuisine as string) || '',
          area: (r.area as string) || '',
          city: (r.city as string) || '',
          address: (r.address as string) || '',
          phone: (r.phone as string) || '',
          price_range: (r.price_range as string) || '',
          hours: (r.hours as string) || '',
          notes: (r.notes as string) || '',
          rank: r.rank != null ? String(r.rank) : '',
          omakase_url: (r.omakase_url as string) || '',
          tablecheck_url: (r.tablecheck_url as string) || '',
          tableall_url: (r.tableall_url as string) || '',
        });
        setScrapeUrl((r.tabelog_url as string) || '');
      });
    }
  }, [restaurantId]);

  const set = (field: string, value: string) => setForm(f => ({ ...f, [field]: value }));

  const handleScrape = async () => {
    if (!scrapeUrl) return;
    setScraping(true);
    setError('');
    try {
      const data = await api<ScrapedData>('/restaurants/scrape', {
        method: 'POST',
        body: JSON.stringify({ url: scrapeUrl }),
      });
      setForm(f => ({
        ...f,
        tabelog_url: scrapeUrl,
        name: data.name || f.name,
        name_ja: data.name_ja || f.name_ja,
        tabelog_score: data.tabelog_score != null ? String(data.tabelog_score) : f.tabelog_score,
        cuisine: data.cuisine || f.cuisine,
        area: data.area || f.area,
        city: data.city || f.city,
        address: data.address || f.address,
        phone: data.phone || f.phone,
        price_range: data.price_range || f.price_range,
        hours: data.hours || f.hours,
      }));
    } catch (e) {
      setError(`Scrape failed: ${e}`);
    } finally {
      setScraping(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const body = {
        ...form,
        tabelog_score: form.tabelog_score ? parseFloat(form.tabelog_score) : null,
        rank: form.rank ? parseInt(form.rank) : null,
        name_ja: form.name_ja || null,
        tabelog_url: form.tabelog_url || null,
        cuisine: form.cuisine || null,
        area: form.area || null,
        city: form.city || null,
        address: form.address || null,
        phone: form.phone || null,
        price_range: form.price_range || null,
        hours: form.hours || null,
        notes: form.notes || null,
        omakase_url: form.omakase_url || null,
        tablecheck_url: form.tablecheck_url || null,
        tableall_url: form.tableall_url || null,
      };
      if (isEdit) {
        await api(`/restaurants/${restaurantId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await api('/restaurants', { method: 'POST', body: JSON.stringify(body) });
      }
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2 className="text-lg font-semibold mb-4">{isEdit ? 'Edit Restaurant' : 'Add Restaurant'}</h2>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>}

      {/* Tabelog import */}
      <div className="mb-4 p-3 bg-gray-50 rounded-md">
        <label className="block text-sm font-medium text-gray-700 mb-1">Import from Tabelog</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={scrapeUrl}
            onChange={e => setScrapeUrl(e.target.value)}
            placeholder="https://tabelog.com/..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <button
            type="button"
            onClick={handleScrape}
            disabled={scraping || !scrapeUrl}
            className="px-4 py-2 bg-gray-700 text-white text-sm rounded-md hover:bg-gray-800 disabled:opacity-50"
          >
            {scraping ? 'Scraping...' : 'Import'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Name *" value={form.name} onChange={v => set('name', v)} />
        <Field label="Japanese Name" value={form.name_ja} onChange={v => set('name_ja', v)} />
        <Field label="Tabelog Score" value={form.tabelog_score} onChange={v => set('tabelog_score', v)} type="number" step="0.01" />
        <Field label="Rank" value={form.rank} onChange={v => set('rank', v)} type="number" />
        <Field label="Cuisine" value={form.cuisine} onChange={v => set('cuisine', v)} />
        <Field label="Area" value={form.area} onChange={v => set('area', v)} />
        <Field label="City" value={form.city} onChange={v => set('city', v)} />
        <Field label="Price Range" value={form.price_range} onChange={v => set('price_range', v)} />
        <Field label="Address" value={form.address} onChange={v => set('address', v)} className="col-span-2" />
        <Field label="Phone" value={form.phone} onChange={v => set('phone', v)} />
        <Field label="Hours" value={form.hours} onChange={v => set('hours', v)} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <Field label="Omakase URL" value={form.omakase_url} onChange={v => set('omakase_url', v)} placeholder="https://omakase.in/..." />
        <Field label="TableCheck URL" value={form.tablecheck_url} onChange={v => set('tablecheck_url', v)} placeholder="https://tablecheck.com/..." />
        <Field label="TableAll URL" value={form.tableall_url} onChange={v => set('tableall_url', v)} placeholder="https://tableall.com/..." />
      </div>

      <div className="mt-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
        <textarea
          value={form.notes}
          onChange={e => set('notes', e.target.value)}
          rows={2}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900">
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({ label, value, onChange, className = '', type = 'text', step, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  type?: string;
  step?: string;
  placeholder?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        step={step}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
      />
    </div>
  );
}
