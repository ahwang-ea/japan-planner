import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Account {
  id: string;
  platform: string;
  email: string;
  last_login_at: string | null;
  is_valid: number;
}

const PLATFORMS = [
  { key: 'omakase', label: 'Omakase', description: 'omakase.in' },
  { key: 'tablecheck', label: 'TableCheck', description: 'tablecheck.com' },
  { key: 'tableall', label: 'TableAll', description: 'tableall.com' },
];

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [editPlatform, setEditPlatform] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', password: '' });
  const [saving, setSaving] = useState(false);

  const load = () => {
    api<Account[]>('/accounts').then(setAccounts);
  };

  useEffect(() => { load(); }, []);

  const getAccount = (platform: string) => accounts.find(a => a.platform === platform);

  const handleSave = async (platform: string) => {
    if (!form.email || !form.password) return;
    setSaving(true);
    await api('/accounts', {
      method: 'POST',
      body: JSON.stringify({ platform, email: form.email, password: form.password }),
    });
    setEditPlatform(null);
    setForm({ email: '', password: '' });
    setSaving(false);
    load();
  };

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`Remove ${label} account?`)) return;
    await api(`/accounts/${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Booking Accounts</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLATFORMS.map(p => {
          const account = getAccount(p.key);
          const isEditing = editPlatform === p.key;

          return (
            <div key={p.key} className="bg-white rounded-lg border border-gray-200 p-5">
              <h3 className="font-semibold text-gray-900">{p.label}</h3>
              <p className="text-xs text-gray-400 mb-3">{p.description}</p>

              {account && !isEditing ? (
                <div>
                  <div className="text-sm text-gray-700">{account.email}</div>
                  <div className="flex items-center gap-1 mt-1">
                    <span className={`w-2 h-2 rounded-full ${account.is_valid ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className="text-xs text-gray-500">{account.is_valid ? 'Active' : 'Invalid'}</span>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => { setEditPlatform(p.key); setForm({ email: account.email, password: '' }); }}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      Update
                    </button>
                    <button
                      onClick={() => handleDelete(account.id, p.label)}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : isEditing ? (
                <div className="space-y-2">
                  <input
                    value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="Email"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  />
                  <input
                    type="password"
                    value={form.password}
                    onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    placeholder="Password"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(p.key)}
                      disabled={saving}
                      className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={() => { setEditPlatform(null); setForm({ email: '', password: '' }); }}
                      className="text-xs text-gray-600"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setEditPlatform(p.key)}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  Add credentials
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
