// routes/listings.js
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();

// ---- data file (JSON on disk) ---------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DATA_FILE  = path.join(__dirname, '..', 'data', 'listings.json');

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const seed = {
      listings: [
        {
          id: '175875',
          title: 'Luxury Apartment',
          city: 'Lagos',
          area: 'Victoria Island',
          pricePerNight: 20000,
          status: 'active',
          featured: true,
          ownerId: 'user123',
          createdAt: new Date().toISOString()
        },
        {
          id: '175876',
          title: '3-Bedroom Flat',
          city: 'Abuja',
          area: 'Gwarinpa',
          pricePerNight: 25000,
          status: 'review',
          featured: false,
          ownerId: 'users456',
          createdAt: new Date().toISOString()
        }
      ]
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2), 'utf8');
  }
}
function loadAll() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8') || '{}';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.listings) ? parsed.listings : [];
  } catch {
    return [];
  }
}
function saveAll(listings) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify({ listings }, null, 2), 'utf8');
}

// ---- helpers ---------------------------------------------------
function toRow(l) {
  return {
    id: String(l.id ?? ''),
    title: l.title ?? '—',
    city: l.city ?? '—',
    area: l.area ?? '—',
    pricePerNight: Number(l.pricePerNight ?? 0),
    status: l.status ?? 'active',
    featured: !!l.featured,
    ownerId: l.ownerId ?? '—',
    createdAt: l.createdAt ?? null,
  };
}
function paginate(arr, page = 1, perPage = 10) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const n = Math.max(1, parseInt(perPage, 10) || 10);
  const start = (p - 1) * n;
  return { slice: arr.slice(start, start + n), total: arr.length, page: p, perPage: n };
}

// ---- PUBLIC: /api/listings ------------------------------------
// Optional query: q, page, limit, featured=all|yes|no
router.get('/listings', (req, res) => {
  try {
    const { q = '', page = 1, limit = 10, featured = 'all' } = req.query;
    let rows = loadAll().map(toRow);

    const needle = String(q).trim().toLowerCase();
    if (needle) {
      rows = rows.filter(r =>
        r.title.toLowerCase().includes(needle) ||
        r.city.toLowerCase().includes(needle) ||
        r.area.toLowerCase().includes(needle)
      );
    }
    if (featured !== 'all') {
      const want = featured === 'yes';
      rows = rows.filter(r => r.featured === want);
    }

    const { slice, total, page: p, perPage } = paginate(rows, page, limit);
    res.json({ data: slice, total, page: p, limit: perPage });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to load listings' });
  }
});

// ---- ADMIN: /api/admin/listings -------------------------------
// Optional query: q, page, limit, status=all|active|review|inactive
router.get('/admin/listings', (req, res) => {
  try {
    const { q = '', page = 1, limit = 10, status = 'all' } = req.query;
    let rows = loadAll().map(toRow);

    const needle = String(q).trim().toLowerCase();
    if (needle) {
      rows = rows.filter(r =>
        r.title.toLowerCase().includes(needle) ||
        r.city.toLowerCase().includes(needle) ||
        r.area.toLowerCase().includes(needle) ||
        r.ownerId.toLowerCase().includes(needle)
      );
    }
    if (status !== 'all') {
      rows = rows.filter(r => (r.status ?? 'active') === status);
    }

    const { slice, total, page: p, perPage } = paginate(rows, page, limit);
    res.json({ data: slice, total, page: p, limit: perPage });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to load listings' });
  }
});

// Toggle/Set featured
router.post('/admin/listings/:id/feature', (req, res) => {
  try {
    const { id } = req.params;
    const { featured } = req.body ?? {};
    const list = loadAll();
    const idx = list.findIndex(l => String(l.id) === String(id));
    if (idx === -1) return res.status(404).json({ message: 'Listing not found' });
    list[idx].featured = typeof featured === 'boolean' ? featured : !list[idx].featured;
    list[idx].updatedAt = new Date().toISOString();
    saveAll(list);
    res.json({ ok: true, data: toRow(list[idx]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to update featured' });
  }
});

// Approve / Deactivate / Set status
router.patch('/admin/listings/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body ?? {};
    if (!status) return res.status(400).json({ message: 'status is required' });

    const list = loadAll();
    const idx = list.findIndex(l => String(l.id) === String(id));
    if (idx === -1) return res.status(404).json({ message: 'Listing not found' });

    list[idx].status = status;
    list[idx].updatedAt = new Date().toISOString();
    saveAll(list);
    res.json({ ok: true, data: toRow(list[idx]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to update status' });
  }
});

// Convenience endpoints your UI might be calling already
router.post('/admin/listings/:id/approve', (req, res, next) => {
  req.method = 'PATCH';
  req.url = `/admin/listings/${req.params.id}/status`;
  req.body = { status: 'active' };
  next();
});
router.post('/admin/listings/:id/deactivate', (req, res, next) => {
  req.method = 'PATCH';
  req.url = `/admin/listings/${req.params.id}/status`;
  req.body = { status: 'inactive' };
  next();
});
router.post('/admin/listings/:id/unfeature', (req, res, next) => {
  req.method = 'POST';
  req.url = `/admin/listings/${req.params.id}/feature`;
  req.body = { featured: false };
  next();
});

export default router; 
