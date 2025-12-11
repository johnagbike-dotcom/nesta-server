// server/index.js  (ESM)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { db, adminAuth } from './firebaseAdmin.js';
import requireAdmin from './middleware/requireAdmin.js';
import adminRoutes from "./adminRoutes.js";
const app = express();
const PORT = process.env.PORT || 4000;
const featureRequestsRouter = require("../routes/featureRequest");
// --- middleware ---
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
// mount admin API under /api/admin
app.use("/api/admin", adminRoutes);
app.use("/api", featureRequestsRouter);
// --- utils ---
const col = (name) => db.collection(name);
const nowISO = () => new Date().toISOString();

async function updateBookingStatus(id, patch) {
  patch.updatedAt = nowISO();
  await col('bookings').doc(id).set(patch, { merge: true });
  const snap = await col('bookings').doc(id).get();
  return { id: snap.id, ...snap.data() };
}

function pick(x, keys) {
  return keys.reduce((a, k) => (x[k] !== undefined ? (a[k] = x[k], a) : a), {});
}

// --- health ---
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/**
* LIST bookings (reads Firestore)
* Optional query: ?status=confirmed|pending|cancelled|refunded
*/
app.get('/api/bookings', async (req, res) => {
  try {
    const { status } = req.query;
    let q = col('bookings').orderBy('createdAt', 'desc').limit(500);

    if (status) q = q.where('status', '==', status);

    const snaps = await q.get();
    const data = snaps.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(data);
  } catch (err) {
    console.error('GET /api/bookings', err);
    res.status(500).json({ ok: false, error: 'Failed to list bookings' });
  }
});

/**
* VERIFY booking by provider + reference and write status to Firestore.
* Body: { bookingId, provider: "paystack"|"flutterwave", reference }
*/
app.post('/api/bookings/verify', async (req, res) => {
  try {
    const { bookingId, provider, reference } = req.body || {};
    if (!bookingId || !provider || !reference) {
      return res.status(400).json({ ok: false, error: 'bookingId, provider, reference required' });
    }

    // Ensure booking exists
    const docRef = col('bookings').doc(bookingId);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'booking not found' });

    let ok = false;
    let raw = null;

    if (provider === 'paystack') {
      const key = process.env.PAYSTACK_SECRET_KEY;
      if (!key) return res.status(500).json({ ok: false, error: 'PAYSTACK_SECRET_KEY not set' });

      const r = await axios.get(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${key}` } }
      );
      raw = r.data;
      ok = r?.data?.data?.status === 'success';
    } else if (provider === 'flutterwave') {
      const key = process.env.FLW_SECRET_KEY;
      if (!key) return res.status(500).json({ ok: false, error: 'FLW_SECRET_KEY not set' });

      const r = await axios.get(
        'https://api.flutterwave.com/v3/transactions/verify_by_reference',
        {
          headers: { Authorization: `Bearer ${key}` },
          params: { tx_ref: reference },
        }
      );
      raw = r.data;
      ok = r?.data?.data?.status === 'successful';
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown provider' });
    }

    const status = ok ? 'confirmed' : 'pending';
    const updated = await updateBookingStatus(bookingId, {
      status,
      gateway: provider,
      reference,
      verifiedAt: nowISO(),
      verifyRaw: pick(raw || {}, ['status', 'message']),
    });

    res.json({ ok, booking: updated });
  } catch (err) {
    console.error('POST /api/bookings/verify', err?.response?.data || err.message);
    res.status(500).json({ ok: false, error: 'Verify failed', detail: err?.response?.data || err.message });
  }
});

/**
* ADMIN: cancel booking
* Body: { reason? }
*/
app.post('/api/bookings/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await updateBookingStatus(id, {
      status: 'cancelled',
      cancelReason: req.body?.reason || null,
      cancelledBy: req.user?.uid || 'admin',
      cancelledAt: nowISO(),
    });
    res.json({ ok: true, booking: updated });
  } catch (err) {
    console.error('POST /cancel', err);
    res.status(500).json({ ok: false, error: 'Cancel failed' });
  }
});

/**
* ADMIN: mark refunded
* Body: { reference?, note? }
*/
app.post('/api/bookings/:id/refund', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await updateBookingStatus(id, {
      status: 'refunded',
      refundReference: req.body?.reference || null,
      refundNote: req.body?.note || null,
      refundedBy: req.user?.uid || 'admin',
      refundedAt: nowISO(),
    });
    res.json({ ok: true, booking: updated });
  } catch (err) {
    console.error('POST /refund', err);
    res.status(500).json({ ok: false, error: 'Refund failed' });
  }
});

// ----------------- WEBHOOKS -----------------

// Paystack: header x-paystack-signature (HMAC SHA512 over raw body using secret)
import crypto from 'crypto';
app.post('/api/paystack/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const sig = req.headers['x-paystack-signature'];
    const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
    if (sig !== hash) return res.status(401).end();

    const payload = JSON.parse(req.body.toString());
    const event = payload?.event;
    const data = payload?.data;
    const ref = data?.reference;
    const txStatus = data?.status;

    // Find booking by reference
    const q = await col('bookings').where('reference', '==', ref).limit(1).get();
    if (q.empty) return res.json({ ok: true }); // nothing to update on our side

    const id = q.docs[0].id;

    if (event === 'charge.success' && txStatus === 'success') {
      await updateBookingStatus(id, { status: 'confirmed', gateway: 'paystack', verifiedAt: nowISO() });
    } else if (event === 'refund.processed') {
      await updateBookingStatus(id, { status: 'refunded', gateway: 'paystack' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Paystack webhook', err.message);
    res.status(500).end();
  }
});

// Flutterwave: header verif-hash equals your FLW_WEBHOOK_HASH
app.post('/api/flutterwave/webhook', express.json(), async (req, res) => {
  try {
    const hash = req.headers['verif-hash'];
    if (!hash || hash !== process.env.FLW_WEBHOOK_HASH) return res.status(401).end();

    const payload = req.body;
    const event = payload?.event;
    const data = payload?.data;
    const ref = data?.tx_ref;
    const txStatus = data?.status;

    // Find booking by reference
    const q = await col('bookings').where('reference', '==', ref).limit(1).get();
    if (q.empty) return res.json({ ok: true });

    const id = q.docs[0].id;

    if (event === 'charge.completed' && txStatus === 'successful') {
      await updateBookingStatus(id, { status: 'confirmed', gateway: 'flutterwave', verifiedAt: nowISO() });
    } else if (event?.includes('refund')) {
      await updateBookingStatus(id, { status: 'refunded', gateway: 'flutterwave' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Flutterwave webhook', err.message);
    res.status(500).end();
  }
});

// ----------------- SETTINGS (persist in Firestore) -----------------
app.get('/api/admin/settings', requireAdmin, async (_req, res) => {
  try {
    const snap = await col('admin').doc('settings').get();
    res.json({ ok: true, data: snap.exists ? snap.data() : {} });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Failed to read settings' });
  }
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const data = req.body || {};
    await col('admin').doc('settings').set({ ...data, updatedAt: nowISO() }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Failed to save settings' });
  }
});

app.listen(PORT, () => {
  console.log(`Nesta API on http://localhost:${PORT}`);
});