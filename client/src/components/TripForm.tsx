import { useState, useRef, useEffect } from 'react';
import { api } from '../lib/api';
import { CITIES } from '../lib/constants';
import SmartDateInput from './SmartDateInput';

interface Props {
  onCreated: () => void;
  onCancel: () => void;
}

export default function TripForm({ onCreated, onCancel }: Props) {
  const [form, setForm] = useState({ name: '', city: '', start_date: '', end_date: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const startDate = form.start_date ? new Date(form.start_date + 'T12:00:00') : undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.start_date || !form.end_date) return;
    setSaving(true);
    try {
      await api('/trips', { method: 'POST', body: JSON.stringify(form) });
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  const formRef = useRef<HTMLFormElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const handleRangeParsed = (start: string, end: string) => {
    setForm(f => ({ ...f, start_date: start, end_date: end }));
  };

  const endBeforeStart = form.start_date && form.end_date && form.end_date < form.start_date;

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      className="mb-6 bg-white rounded-lg border border-gray-200 p-6"
    >
      <h2 className="text-lg font-semibold mb-4">Create Trip</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Trip Name *</label>
          <input
            ref={nameRef}
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g., Tokyo May 2025"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
          <select
            value={form.city}
            onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm capitalize focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">Select a city</option>
            {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SmartDateInput
            label="Start Date"
            required
            value={form.start_date}
            onChange={d => setForm(f => ({ ...f, start_date: d }))}
            onRangeParsed={handleRangeParsed}
            placeholder="e.g., may 15 or june 3-10"
          />
          <SmartDateInput
            label="End Date"
            required
            value={form.end_date}
            onChange={d => setForm(f => ({ ...f, end_date: d }))}
            referenceDate={startDate}
            placeholder="e.g., may 22"
          />
        </div>

        {endBeforeStart && (
          <p className="text-xs text-amber-600">End date is before start date</p>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
          <textarea
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            rows={2}
            placeholder="Optional"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving || !form.name || !form.start_date || !form.end_date}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Creating...' : 'Create'}
          </button>
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900">
            Cancel
          </button>
          <span className="text-xs text-gray-400 ml-auto flex items-center gap-3">
            <span><kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">&#8984;Enter</kbd> to create</span>
            <span><kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 text-gray-500">Esc</kbd> to cancel</span>
          </span>
        </div>
      </div>
    </form>
  );
}
