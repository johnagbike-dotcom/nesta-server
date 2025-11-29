// nesta-server/routes/bookings.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();

// ---------- optional Firestore (via firebaseAdmin.js) ----------
let fdb = null;
try {
  const adminMod = await import("../firebaseAdmin.js");
  const admin = adminMod?.default || adminMod;
  if (admin?.apps?.length) {
    const fa = await import("firebase-admin/firestore");
    fdb = fa.getFirestore();
  }
} catch {
  // no firebase admin – we just use JSON files
}

// ---------- file helpers ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");

function ensureFile(file, seed) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify(seed ?? { bookings: [] }, null, 2),
      "utf8"
    );
  }
}
function readJSON(file, seed) {
  ensureFile(file, seed);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return seed ?? { bookings: [] };
  }
}
function writeJSON(file, data) {
  ensureFile(file, data);
  fs.writeFileSync(
    file,
    JSON.stringify(data ?? { bookings: [] }, null, 2),
    "utf8"
  );
}

// ---------- helpers ----------
function normalizeBooking(id, raw = {}) {
  const b = raw || {};
  const createdAt =
    b.createdAt || b.created || b.created_at || b.timestamp || null;
  const updatedAt = b.updatedAt || b.updated || null;

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

    // money + stay
    nights: Number(b.nights || b.nightCount || 0),
    amount: Number(b.amountN || b.amount || b.totalAmount || b.total || 0),
    currency: b.currency || "NGN",

    // status
    status: String(b.status || b.gateway || "pending").toLowerCase(),
    provider: b.provider || "paystack",
    gateway: b.gateway || "success",

    // timestamps
    createdAt,
    updatedAt,

    // keep any other fields just in case
    ...b,
  };
}

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

// ---------- GET /api/bookings ----------
router.get("/", async (_req, res) => {
  try {
    let bookings = [];

    // 1) Prefer Firestore if configured
    if (fdb) {
      bookings = await loadBookingsFromFirestore();
    }

    // 2) Fallback: local JSON store
    if (!bookings.length) {
      const db = readJSON(BOOKINGS_FILE, { bookings: [] });
      bookings = db.bookings || [];
    }

    res.json(bookings); // the UI expects an array
  } catch (e) {
    console.error("GET /bookings failed:", e);
    res.status(500).json({ message: "Failed to load bookings" });
  }
});

// ---------- PATCH /api/bookings/:id/status ----------
router.patch("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const next = String(req.body?.status || "").toLowerCase();
    if (!["pending", "confirmed", "cancelled", "refunded"].includes(next)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    // 1) Update local JSON (for CSV/export + demo data)
    const db = readJSON(BOOKINGS_FILE, { bookings: [] });
    const idx = (db.bookings || []).findIndex(
      (b) =>
        String(b.id || b._id || b.reference || b.ref || b.bookingId) ===
        String(id)
    );
    if (idx !== -1) {
      db.bookings[idx].status = next;
      db.bookings[idx].updatedAt = new Date().toISOString();
      writeJSON(BOOKINGS_FILE, db);
    }

    // 2) Update Firestore if available
    if (fdb) {
      try {
        let ref = null;
        const colNames = ["Bookings", "bookings"];

        for (const name of colNames) {
          const col = fdb.collection(name);

          // first, try by document id
          const docSnap = await col.doc(id).get();
          if (docSnap.exists) {
            ref = col.doc(id);
            break;
          }

          // then, try by reference field
          const qSnap = await col
            .where("reference", "==", id)
            .limit(1)
            .get();
          if (!qSnap.empty) {
            ref = qSnap.docs[0].ref;
            break;
          }
        }

        if (ref) {
          await ref.set(
            { status: next, updatedAt: new Date().toISOString() },
            { merge: true }
          );
        }
      } catch (err) {
        console.error("Firestore sync for booking status failed:", err);
        // we don't fail the HTTP request if Firestore write fails
      }
    }

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

// ---------- optional POST shorthands ----------
["confirmed", "cancelled", "refunded"].forEach((s) => {
  router.post(`/:id/${s}`, (req, res, next) => {
    req.method = "PATCH";
    req.url = `/${req.params.id}/status`;
    req.body = { status: s };
    next();
  });
});

export default router;
