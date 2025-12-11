// routes/hostRoutes.js  (ESM)
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();

// ---------- file helpers ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DATA_DIR   = path.join(__dirname, '..', 'data');

const LISTINGS_FILE = path.join(DATA_DIR, 'listings.json');       // { listings: [] }
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');       // { bookings: [] }
const USERS_FILE    = path.join(DATA_DIR, 'users.json');          // { users: [] }
const FEATURE_FILE  = path.join(DATA_DIR, 'feature-requests.json'); // { requests: [] }

function ensureFile(file, seed) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(seed ?? {}, null, 2), 'utf8');
}
function readJSON(file, seed) {
  ensureFile(file, seed);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return seed ?? {}; }
}
function writeJSON(file, data) {
  ensureFile(file, data ?? {});
  fs.writeFileSync(file, JSON.stringify(data ?? {}, null, 2), 'utf8');
}

// ---------- small utils ----------
const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const between = (ts, from, to) => {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  return (from ? t >= from : true) && (to ? t <= to : true);
};

// ===================================================================
// AUTH NOTE (mock):
// We accept hostId from query/header for now. In your real app you’ll
// pick it from the auth session/JWT.
// ===================================================================

// GET /api/host/stats?hostId=U123&range=30d|90d|all
router.get('/stats', (req, res) => {
  try {
    const hostId = String(req.query.hostId || '').trim();
    if (!hostId) return res.status(400).json({ message: 'hostId required' });

    const listingsDb = readJSON(LISTINGS_FILE, { listings: [] });
    const bookingsDb = readJSON(BOOKINGS_FILE, { bookings: [] });

    const myListings = (listingsDb.listings || []).filter(l => String(l.ownerId) === hostId);
    const myIds = new Set(myListings.map(l => String(l.id)));

    // date window
    const now = Date.now();
    const range = String(req.query.range || '30d');
    const from =
      range === '90d' ? now - 90 * 864e5 :
      range === 'all' ? null :
      now - 30 * 864e5;

    const myBookings = (bookingsDb.bookings || []).filter(b => {
      const byListing = myIds.has(String(b.listingId || b.listing_id || b.listing));
      const okDate = between(b.createdAt || b.date || b.created_at, from, null);
      return byListing && okDate;
    });

    const totalListings  = myListings.length;
    const activeListings = myListings.filter(l => (l.status || 'active') === 'active').length;
    const featuredCount  = myListings.filter(l => !!l.featured).length;

    const confirmed = myBookings.filter(b => (b.status || 'pending') === 'confirmed');
    const cancelled = myBookings.filter(b => (b.status || 'pending') === 'cancelled');

    const nights = (arr) => arr.reduce((s, b) => s + (toInt(b.nights || b.night, 1)), 0);
    const sum    = (arr) => arr.reduce((s, b) => s + (Number(b.amount || b.total || 0)), 0);

    const stats = {
      totals: {
        listings: totalListings,
        active: activeListings,
        featured: featuredCount,
        bookings: myBookings.length,
      },
      bookings: {
        confirmed: confirmed.length,
        cancelled: cancelled.length,
        nights: nights(confirmed),
        revenue: sum(confirmed),
      }
    };

    res.json({ data: stats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to load stats' });
  }
});

// GET /api/host/listings?hostId=U123&status=all|active|inactive|review
router.get('/listings', (req, res) => {
  try {
    const hostId = String(req.query.hostId || '').trim();
    const status = String(req.query.status || 'all');
    if (!hostId) return res.status(400).json({ message: 'hostId required' });

    const db = readJSON(LISTINGS_FILE, { listings: [] });
    let list = (db.listings || []).filter(l => String(l.ownerId) === hostId);
    if (status !== 'all') list = list.filter(l => String(l.status || 'active') === status);

    res.json({ data: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to load listings' });
  }
});

// PATCH /api/host/listings/:id/status { status: 'active'|'inactive'|'review' }
router.patch('/listings/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const { status, hostId } = req.body || {};
    if (!hostId)  return res.status(400).json({ message: 'hostId required' });
    if (!status)  return res.status(400).json({ message: 'status required' });

    const db = readJSON(LISTINGS_FILE, { listings: [] });
    const idx = (db.listings || []).findIndex(l => String(l.id) === String(id));
    if (idx === -1) return res.status(404).json({ message: 'Listing not found' });
    if (String(db.listings[idx].ownerId) !== String(hostId)) {
      return res.status(403).json({ message: 'Not your listing' });
    }
    db.listings[idx].status = status;
    db.listings[idx].updatedAt = new Date().toISOString();
    writeJSON(LISTINGS_FILE, db);
    res.json({ ok: true, data: db.listings[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to update listing' });
  }
});

// GET /api/host/bookings?hostId=U123&status=all|pending|confirmed|cancelled|refunded
router.get('/bookings', (req, res) => {
  try {
    const hostId = String(req.query.hostId || '').trim();
    const status = String(req.query.status || 'all');

    if (!hostId) return res.status(400).json({ message: 'hostId required' });

    const listingsDb = readJSON(LISTINGS_FILE, { listings: [] });
    const bookingsDb = readJSON(BOOKINGS_FILE, { bookings: [] });
    const myIds = new Set((listingsDb.listings || [])
      .filter(l => String(l.ownerId) === hostId)
      .map(l => String(l.id)));

    let rows = (bookingsDb.bookings || []).filter(b => myIds.has(String(b.listingId || b.listing_id || b.listing)));
    if (status !== 'all') rows = rows.filter(b => String(b.status || 'pending') === status);

    res.json({ data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to load bookings' });
  }
});

// GET /api/host/earnings?hostId=U123&range=30d|90d|all
router.get('/earnings', (req, res) => {
  try {
    const hostId = String(req.query.hostId || '').trim();
    if (!hostId) return res.status(400).json({ message: 'hostId required' });

    const listingsDb = readJSON(LISTINGS_FILE, { listings: [] });
    const bookingsDb = readJSON(BOOKINGS_FILE, { bookings: [] });

    const myIds = new Set((listingsDb.listings || [])
      .filter(l => String(l.ownerId) === hostId)
      .map(l => String(l.id)));

    const now = Date.now();
    const range = String(req.query.range || '30d');
    const from =
      range === '90d' ? now - 90 * 864e5 :
      range === 'all' ? null :
      now - 30 * 864e5;

    const confirmed = (bookingsDb.bookings || []).filter(b =>
      myIds.has(String(b.listingId || b.listing_id || b.listing)) &&
      String(b.status || 'pending') === 'confirmed' &&
      between(b.createdAt || b.date || b.created_at, from, null)
    );

    const gross = confirmed.reduce((s, b) => s + (Number(b.amount || b.total || 0)), 0);
    const nights = confirmed.reduce((s, b) => s + (toInt(b.nights || b.night, 1)), 0);
    res.json({ data: { gross, nights, count: confirmed.length } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to load earnings' });
  }
});

// POST /api/host/feature-requests  { hostId, title, details, priority }
router.post('/feature-requests', (req, res) => {
  try {
    const { hostId, title, details = '', priority = 'medium' } = req.body || {};
    if (!hostId || !title) return res.status(400).json({ message: 'hostId and title required' });

    const db = readJSON(FEATURE_FILE, { requests: [] });
    const id = `FR${String(Date.now()).slice(-6)}`;
    const item = {
      id,
      title,
      details,
      user: hostId,
      status: 'pending',
      priority,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.requests = Array.isArray(db.requests) ? db.requests : [];
    db.requests.unshift(item);
    writeJSON(FEATURE_FILE, db);
    res.json({ ok: true, data: item });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to submit request' });
  }
});

export default router;