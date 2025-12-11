// nesta-server/routes/bookings.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();

/* ───────────────────── Optional Firestore (firebaseAdmin.js) ───────────────────── */
let fdb = null;
try {
  const mod = await import("../firebaseAdmin.js");
  const db = mod.adminDb || mod.default || null;
  if (db) {
    fdb = db;
    console.log("[bookings] Firestore connected");
  } else {
    console.log("[bookings] firebaseAdmin.js loaded but no adminDb export");
  }
} catch (err) {
  console.log("[bookings] No Firestore, using JSON only:", err.message);
}

/* ───────────────────────── File helpers ───────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");
const PAYOUTS_FILE = path.join(DATA_DIR, "payouts.json");

function ensureFile(file, seed) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(seed ?? {}, null, 2), "utf8");
  }
}
function readJSON(file, seed) {
  ensureFile(file, seed);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return seed ?? {};
  }
}
function writeJSON(file, data) {
  ensureFile(file, data ?? {});
  fs.writeFileSync(file, JSON.stringify(data ?? {}, null, 2), "utf8");
}

/* ───────────────────────── Utility helpers ───────────────────────── */

// Normalise Firestore Timestamp / number / string → ISO string
function normalizeDateValue(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return new Date(v).toISOString(); // ms epoch
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Turn raw booking from FS/JSON into a consistent, flat shape
function normalizeBooking(id, raw = {}) {
  const b = raw || {};

  const createdRaw =
    b.createdAt || b.created || b.created_at || b.timestamp || null;
  const updatedRaw = b.updatedAt || b.updated || null;

  const checkInRaw = b.checkIn || b.startDate || b.from || null;
  const checkOutRaw = b.checkOut || b.endDate || b.to || null;

  return {
    // IDs / refs
    id,
    reference: b.reference || b.ref || id,

    // listing / parties
    listingId: b.listingId || b.listing || "",
    listingTitle: b.listingTitle || b.listing || b.title || "",
    guestEmail: b.email || b.guestEmail || b.guest || "",
    guestId: b.guestId || b.userId || "",
    hostId: b.hostId || b.ownerId || "",
    ownerId: b.ownerId || b.hostId || "",
    partnerUid: b.partnerUid || null,

    // money + stay
    nights: Number(b.nights || b.nightCount || 0),
    amount:
      Number(
        b.amountN ||
          b.amount ||
          b.totalAmount ||
          b.total ||
          0
      ) || 0,
    currency: b.currency || "NGN",

    // status / gateway
    status: String(b.status || b.gateway || "pending").toLowerCase(),
    provider: b.provider || "paystack",
    gateway: b.gateway || "success",

    // dates (normalised)
    checkIn: normalizeDateValue(checkInRaw),
    checkOut: normalizeDateValue(checkOutRaw),
    createdAt: normalizeDateValue(createdRaw),
    updatedAt: normalizeDateValue(updatedRaw),

    // keep everything else
    ...b,
  };
}

// Firestore → array of normalised bookings
async function loadBookingsFromFirestore() {
  if (!fdb) return [];
  const names = ["Bookings", "bookings"];
  for (const name of names) {
    const snap = await fdb.collection(name).get();
    if (!snap.empty) {
      return snap.docs.map((doc) => normalizeBooking(doc.id, doc.data()));
    }
  }
  return [];
}

// Resolve a booking by id or reference across Firestore + JSON
async function resolveBooking(idRaw) {
  const id = String(idRaw);
  let fsRef = null;
  let fsData = null;

  // Firestore first (Bookings / bookings)
  if (fdb) {
    try {
      const colNames = ["Bookings", "bookings"];
      for (const name of colNames) {
        const col = fdb.collection(name);

        // Try document id directly
        let snap = await col.doc(id).get();
        if (snap.exists) {
          fsRef = col.doc(id);
          fsData = snap.data() || {};
          break;
        }

        // Fallback: lookup by reference field
        snap = await col.where("reference", "==", id).limit(1).get();
        if (!snap.empty) {
          const d = snap.docs[0];
          fsRef = d.ref;
          fsData = d.data() || {};
          break;
        }
      }
    } catch (e) {
      console.error("resolveBooking Firestore failed:", e);
    }
  }

  // JSON store backup
  const db = readJSON(BOOKINGS_FILE, { bookings: [] });
  const rows = db.bookings || [];
  const idx = rows.findIndex(
    (b) =>
      String(b.id || b._id || b.reference || b.ref || b.bookingId) === id
  );
  const jsonRow = idx !== -1 ? rows[idx] : null;

  let booking = null;
  if (fsRef) {
    booking = {
      ...normalizeBooking(fsRef.id, fsData),
      ...(jsonRow || {}),
      firestoreId: fsRef.id,
    };
  } else if (jsonRow) {
    booking = normalizeBooking(
      jsonRow.id || jsonRow._id || jsonRow.reference || jsonRow.ref || id,
      jsonRow
    );
  }

  return { booking, db, idx, fsRef };
}

/* ───────────────────── Payout helper (shared with admin) ───────────────────── */
function createPayout({ payeeEmail, payeeType = "host", amount, ref, note = "" }) {
  const db = readJSON(PAYOUTS_FILE, { payouts: [] });
  const id = `po_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  const now = new Date().toISOString();
  const row = {
    id,
    date: now,
    payeeEmail: String(payeeEmail || "-"),
    payeeType: String(payeeType || "host"),
    amount: Number(amount || 0), // can be negative for refunds
    currency: "NGN",
    status: "pending",
    ref: String(ref || id),
    note,
    createdAt: now,
    updatedAt: now,
  };
  db.payouts = db.payouts || [];
  db.payouts.unshift(row);
  writeJSON(PAYOUTS_FILE, db);
  return row;
}

/* ───────────────────────── Routes ───────────────────────── */

// GET /api/bookings  – list bookings for admin/host/guest UIs
router.get("/", async (_req, res) => {
  try {
    let bookings = [];

    // 1) Prefer Firestore
    if (fdb) {
      bookings = await loadBookingsFromFirestore();
    }

    // 2) Fallback: local JSON only if Firestore empty
    if (!bookings.length) {
      const db = readJSON(BOOKINGS_FILE, { bookings: [] });
      bookings =
        (db.bookings || []).map((b) =>
          normalizeBooking(
            b.id || b._id || b.reference || b.ref || b.bookingId,
            b
          )
        ) || [];
    }

    res.json(bookings); // UI expects an array
  } catch (e) {
    console.error("GET /bookings failed:", e);
    res.status(500).json({ message: "Failed to load bookings" });
  }
});

// GET /api/bookings/:id – single booking
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { booking } = await resolveBooking(id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    return res.json(booking);
  } catch (e) {
    console.error("GET /bookings/:id failed:", e);
    res.status(500).json({ message: "Failed to load booking" });
  }
});

// PATCH /api/bookings/:id/status – generic status update (no payouts here)
router.patch("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const next = String(req.body?.status || "").toLowerCase();
    const allowed = ["pending", "confirmed", "cancelled", "refunded"];
    if (!allowed.includes(next)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const nowIso = new Date().toISOString();

    // 1) Update JSON mirror (for CSV/export and legacy data)
    const db = readJSON(BOOKINGS_FILE, { bookings: [] });
    const rows = db.bookings || [];
    const idx = rows.findIndex(
      (b) =>
        String(b.id || b._id || b.reference || b.ref || b.bookingId) ===
        String(id)
    );
    if (idx !== -1) {
      rows[idx] = {
        ...rows[idx],
        status: next,
        updatedAt: nowIso,
      };
      db.bookings = rows;
      writeJSON(BOOKINGS_FILE, db);
    }

    // 2) Update Firestore (Bookings / bookings)
    if (fdb) {
      try {
        let ref = null;
        const colNames = ["Bookings", "bookings"];

        for (const name of colNames) {
          const col = fdb.collection(name);

          // Try by doc id
          let docSnap = await col.doc(id).get();
          if (docSnap.exists) {
            ref = col.doc(id);
            break;
          }

          // Try by reference field
          const qSnap = await col.where("reference", "==", id).limit(1).get();
          if (!qSnap.empty) {
            ref = qSnap.docs[0].ref;
            break;
          }
        }

        if (ref) {
          await ref.set(
            { status: next, updatedAt: nowIso },
            { merge: true }
          );
        }
      } catch (err) {
        console.error("Firestore sync for booking status failed:", err);
      }
    }

    // Important: NO payout creation here. Admin + /:id/refund handle payouts.

    if (idx === -1) {
      // JSON store didn’t have it, but Firestore may have – still return ok
      return res.json({ ok: true, status: next });
    }

    res.json({ ok: true, booking: db.bookings[idx] });
  } catch (e) {
    console.error("PATCH /bookings/:id/status failed:", e);
    res.status(500).json({ message: "Failed to update status" });
  }
});

// POST /api/bookings/:id/cancel – guest/host cancel request → cancelled
router.post("/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    const { booking, db, idx, fsRef } = await resolveBooking(id);

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const current = String(booking.status || "").toLowerCase();
    if (["cancelled", "refunded"].includes(current)) {
      return res
        .status(400)
        .json({ message: "Booking already cancelled or refunded." });
    }

    const nowIso = new Date().toISOString();

    // 1) JSON mirror
    if (idx !== -1) {
      const rows = db.bookings || [];
      rows[idx] = {
        ...rows[idx],
        status: "cancelled",
        cancelRequested: false,
        cancellationRequested: false,
        updatedAt: nowIso,
      };
      db.bookings = rows;
      writeJSON(BOOKINGS_FILE, db);
    }

    // 2) Firestore mirror
    if (fsRef) {
      try {
        await fsRef.set(
          {
            status: "cancelled",
            cancelRequested: false,
            cancellationRequested: false,
            updatedAt: nowIso,
            request: {
              type: "cancel",
              state: "cancelled_by_guest",
              at: new Date(nowIso),
            },
          },
          { merge: true }
        );
      } catch (e) {
        console.error("Firestore mirror for cancel failed:", e);
      }
    }

    return res.json({ ok: true, status: "cancelled" });
  } catch (e) {
    console.error("POST /bookings/:id/cancel failed:", e);
    res.status(500).json({ message: "Failed to cancel booking" });
  }
});

// POST /api/bookings/:id/refund – host/admin refund from app side
router.post("/:id/refund", async (req, res) => {
  try {
    const { id } = req.params;
    const note = String(req.body?.note || "manual_refund");

    const { booking, db, idx, fsRef } = await resolveBooking(id);

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const current = String(booking.status || "").toLowerCase();
    if (current === "refunded") {
      return res.status(400).json({ message: "Booking already refunded." });
    }

    const nowIso = new Date().toISOString();

    // 1) JSON mirror – mark refunded
    if (idx !== -1) {
      const rows = db.bookings || [];
      rows[idx] = {
        ...rows[idx],
        status: "refunded",
        cancelRequested: false,
        cancellationRequested: false,
        updatedAt: nowIso,
      };
      db.bookings = rows;
      writeJSON(BOOKINGS_FILE, db);
    }

    // 2) Firestore mirror
    if (fsRef) {
      try {
        await fsRef.set(
          {
            status: "refunded",
            cancelRequested: false,
            cancellationRequested: false,
            updatedAt: nowIso,
            request: {
              type: "refund",
              state: "host_approved_refund",
              at: new Date(nowIso),
              note,
            },
          },
          { merge: true }
        );
      } catch (e) {
        console.error("Firestore mirror for refund failed:", e);
      }
    }

    // 3) Create a payout record (negative amount to represent refund)
    const gross =
      Number(
        booking.total ||
          booking.amount ||
          booking.amountN ||
          booking.totalAmount ||
          0
      ) || 0;

    const hostShare = Math.round(gross * 0.9); // 90/10 split
    const refundAmount = -hostShare; // negative for refund

    const hostEmail =
      booking.hostEmail ||
      booking.ownerEmail ||
      booking.payeeEmail ||
      booking.listingOwner ||
      "host@nesta.dev";

    createPayout({
      payeeEmail: hostEmail,
      payeeType: "host",
      amount: refundAmount,
      ref: `bo_${id}`,
      note: note || "Host approved refund",
    });

    return res.json({ ok: true, status: "refunded" });
  } catch (e) {
    console.error("POST /bookings/:id/refund failed:", e);
    res.status(500).json({ message: "Failed to mark refund" });
  }
});

// ───────────────── CONTACT REVEAL ENDPOINT ─────────────────
// GET /api/bookings/:id/contact – guarded host/partner contact details
router.get("/:id/contact", async (req, res) => {
  try {
    if (!fdb) {
      return res
        .status(400)
        .json({ message: "Contact details are not available right now." });
    }

    const { id } = req.params;
    const { booking } = await resolveBooking(id);

    if (!booking) {
      return res.status(404).json({ message: "Booking not found." });
    }

    const status = String(booking.status || "").toLowerCase();

    // Block obviously ineligible states
    if (
      ["pending", "cancelled", "refunded", "failed", "expired"].includes(
        status
      )
    ) {
      return res.status(403).json({
        message:
          "Contact details are only available for active, confirmed bookings.",
      });
    }

    // Block if there is any outstanding cancel / refund request
    if (
      booking.cancellationRequested === true ||
      booking.cancelRequested === true ||
      String(booking.gateway || "").toLowerCase() === "refund_requested" ||
      String(booking.status || "").toLowerCase() === "refund_requested"
    ) {
      return res.status(403).json({
        message:
          "Contact details are locked while a cancellation or refund is in progress.",
      });
    }

    // Timing rule: only from 5 days before check-in onwards
    const now = new Date();
    let checkIn = booking.checkIn ? new Date(booking.checkIn) : null;
    if (checkIn && !isNaN(checkIn)) {
      const diffMs = checkIn.getTime() - now.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays > 5) {
        return res.status(403).json({
          message:
            "Contact details will be available closer to check-in (within 5 days).",
        });
      }
    }

    // Resolve host / partner user id
    const hostUid =
      booking.ownerId || booking.hostId || booking.partnerUid || null;

    if (!hostUid) {
      return res
        .status(404)
        .json({ message: "Host account not linked to this booking." });
    }

    const userSnap = await fdb.collection("users").doc(hostUid).get();
    if (!userSnap.exists) {
      return res
        .status(404)
        .json({ message: "Host profile not found for this booking." });
    }

    const u = userSnap.data() || {};

    // Subscription + KYC gates
    const subActive =
      u.activeSubscription === true ||
      u.isSubscribed === true ||
      u.isSubscribed === "true";

    let notExpired = true;
    if (u.subscriptionExpiresAt) {
      const expIso = normalizeDateValue(u.subscriptionExpiresAt);
      if (expIso) {
        notExpired = new Date(expIso) > now;
      }
    }

    const kycStatus =
      u.kyc?.kycStatus || u.kycStatus || u.kyc?.status || null;
    const kycOk = !kycStatus || String(kycStatus).toLowerCase() === "approved";

    if (!subActive || !notExpired || !kycOk) {
      return res.status(403).json({
        message:
          "Contact details are only available for verified, subscribed hosts.",
      });
    }

    const phone =
      u.phoneNumber || u.phone || u.contactPhone || u.whatsapp || null;
    const email = u.email || u.contactEmail || null;

    if (!phone && !email) {
      return res
        .status(404)
        .json({ message: "Host has no contact details on file." });
    }

    return res.json({
      phone: phone || null,
      email: email || null,
    });
  } catch (e) {
    console.error("GET /bookings/:id/contact failed:", e);
    res
      .status(500)
      .json({ message: "Could not retrieve contact details for this booking." });
  }
});

// Shorthands: POST /:id/confirmed, /:id/cancelled, /:id/refunded
["confirmed", "cancelled", "refunded"].forEach((s) => {
  router.post(`/:id/${s}`, (req, res, next) => {
    req.method = "PATCH";
    req.url = `/${req.params.id}/status`;
    req.body = { status: s };
    next();
  });
});

export default router;
