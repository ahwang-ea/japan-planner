import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../lib/db.js';

export const accountsRouter = Router();

// List accounts (without passwords)
accountsRouter.get('/', (_req, res) => {
  const accounts = db.prepare(
    'SELECT id, platform, email, last_login_at, is_valid, created_at, updated_at FROM booking_accounts'
  ).all();
  res.json(accounts);
});

// Create/update account
accountsRouter.post('/', (req, res) => {
  const { platform, email, password } = req.body;

  if (!platform || !email || !password) {
    res.status(400).json({ error: 'platform, email, and password are required' });
    return;
  }

  // TODO: encrypt password with crypto.ts
  const passwordEnc = password; // Placeholder until Phase 3

  const existing = db.prepare(
    'SELECT id FROM booking_accounts WHERE platform = ? AND email = ?'
  ).get(platform, email) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE booking_accounts SET password_enc = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(passwordEnc, existing.id);
    res.json({ success: true, id: existing.id });
  } else {
    const id = uuid();
    db.prepare(`
      INSERT INTO booking_accounts (id, platform, email, password_enc)
      VALUES (?, ?, ?, ?)
    `).run(id, platform, email, passwordEnc);
    res.status(201).json({ success: true, id });
  }
});

// Delete account
accountsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM booking_accounts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});
