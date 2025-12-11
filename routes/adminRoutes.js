// routes/adminRoutes.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ───────────────────────────── OPTIONAL FIREBASE ADMIN ───────────────────────────── */

let fdb = null;
try {
  const mod = await import("../firebaseAdmin.js"); // nesta-server/firebaseAdmin.js
  const db = mod.adminDb || mod.default || null;
  if (db) {
    fdb = db;
    console.log("[adminRoutes] Firestore admin connected");
  } else {
    console.log("[adminRoutes] firebaseAdmin.js loaded but no adminDb export");
  }
} catch (err) {
  console.log("[adminRoutes] Firestore admin not available:", err.message);
}

/* ───────────────────────────── BASIC HELPERS ───────────────────────────── */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");

const USERS_FILE    = path.join(DATA_DIR, "users.json");            // { users: [] }
const LISTINGS_FILE = path.join(DATA_DIR, "listings.json");         // { listings: [] }
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");         // { bookings: [] }  (legacy only)
const KYC_FILE      = path.join(DATA_DIR, "kyc.json");              // { requests: [] }
const FEATURE_FILE  = path.join(DATA_DIR, "featureRequests.json");  // { requests: [] }
const PAYOUTS_FILE  = path.join(DATA_DIR, "payouts.json");          // { payouts: [] }
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const ONBOARD_FILE  = path.join(DATA_DIR, "onboarding.json");       // { host: [], partner: [] }

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureFile(file, seed) {
  ensureDir();
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

const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const paginate = (arr, page = 1, limit = 10) => {
  const p = Math.max(1, toInt(page, 1));
  const l = Math.max(1, toInt(limit, 10));
  const start = (p - 1) * l;
  return {
    items: arr.slice(start, start + l),
    page: p,
    limit: l,
    total: arr.length,
  };
};

/* ───────────────────────────── DATE HELPERS ───────────────────────────── */

function parseDateLoose(v) {
  if (!v) return null;

  // Firestore Timestamp { seconds, nanoseconds }
  if (v && typeof v.toDate === "function") {
    try {
      return v.toDate();
    } catch {
      /* ignore */
    }
  }
  if (v && typeof v.seconds === "number") {
    const ms = v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  if (typeof v === "number") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  if (typeof v === "string") {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Always send dates to the frontend as ISO strings (or "").
function normalizeDateValueForApi(v) {
  const d = parseDateLoose(v);
  return d ? d.toISOString() : "";
}

function normalizeRange(q = {}) {
  const fromD = parseDateLoose(q.from);
  const toD = parseDateLoose(q.to);

  let toAdj = toD ? new Date(toD) : null;
  if (toAdj && /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || ""))) {
    // include whole "to" day
    toAdj.setUTCHours(23, 59, 59, 999);
  }

  return [fromD ? fromD.getTime() : null, toAdj ? toAdj.getTime() : null];
}

function rowInRange(row, range, fields) {
  const [fromMs, toMs] = range;
  let best = null;

  for (const f of fields) {
    const d = parseDateLoose(row?.[f]);
    if (!d) continue;
    const ms = d.getTime();
    if (best == null || ms > best) best = ms;
  }
  if (best == null) return false;
  if (fromMs != null && best < fromMs) return false;
  if (toMs != null && best > toMs) return false;
  return true;
}

/* ───────────────────────────── LOADERS (USERS / LISTINGS / BOOKINGS) ───────────────────────────── */

// users + listings still hydrate from JSON, with optional Firestore bootstrap
async function loadUsers() {
  let rows = readJSON(USERS_FILE, { users: [] }).users || [];

  if ((!rows || rows.length === 0) && fdb) {
    try {
      const snap = await fdb.collection("users").get();
      rows = snap.docs.map((doc) => {
        const d = doc.data() || {};
        return {
          id: doc.id,
          email: d.email || "",
          name: d.name || d.displayName || "",
          displayName: d.displayName || d.name || "",
          role: (d.role || "guest").toLowerCase(),
          disabled: !!d.disabled,
          createdAt: normalizeDateValueForApi(
            d.createdAt || d.created_at || null
          ),
          lastLoginAt: normalizeDateValueForApi(d.lastLoginAt || null),
          updatedAt: normalizeDateValueForApi(d.updatedAt || null),
        };
      });
      writeJSON(USERS_FILE, { users: rows });
    } catch (e) {
      console.error("[adminRoutes] loadUsers Firestore bootstrap failed:", e);
    }
  }
  return rows;
}

async function loadListings() {
  let rows = readJSON(LISTINGS_FILE, { listings: [] }).listings || [];

  if ((!rows || rows.length === 0) && fdb) {
    try {
      const snap = await fdb.collection("listings").get();
      rows = snap.docs.map((doc) => {
        const d = doc.data() || {};
        return {
          id: doc.id,
          title: d.title || "",
          city: d.city || "",
          area: d.area || "",
          type: d.type || d.listingType || "",
          pricePerNight: d.pricePerNight || d.nightlyRate || 0,
          status: (d.status || "active").toLowerCase(),
          featured: !!d.featured,
          grade: d.grade || "Standard",
          gradeNote: d.gradeNote || "",
          updatedAt: normalizeDateValueForApi(d.updatedAt || null),
          createdAt: normalizeDateValueForApi(d.createdAt || null),
        };
      });
      writeJSON(LISTINGS_FILE, { listings: rows });
    } catch (e) {
      console.error("[adminRoutes] loadListings Firestore bootstrap failed:", e);
    }
  }
  return rows;
}

// 🔥 FIRESTORE–FIRST BOOKINGS: Admin always reads actual data, JSON is legacy only.
async function loadBookings() {
  if (fdb) {
    try {
      const names = ["Bookings", "bookings"];
      for (const name of names) {
        const snap = await fdb.collection(name).get();
        if (!snap.empty) {
          const rows = snap.docs.map((doc) => {
            const d = doc.data() || {};

            const createdRaw =
              d.createdAt || d.created || d.created_at || d.timestamp || null;
            const updatedRaw = d.updatedAt || d.updated || null;
            const checkInRaw = d.checkIn || d.startDate || d.from || null;
            const checkOutRaw = d.checkOut || d.endDate || d.to || null;

            return {
              id: doc.id,
              ...d,
              createdAt: normalizeDateValueForApi(createdRaw),
              updatedAt: normalizeDateValueForApi(updatedRaw),
              checkIn: normalizeDateValueForApi(checkInRaw),
              checkOut: normalizeDateValueForApi(checkOutRaw),
            };
          });
          return rows;
        }
      }
    } catch (e) {
      console.error("[adminRoutes] Firestore bookings read failed:", e);
    }
  }

  // Fallback: local JSON (old demo data) – only used if Firestore totally missing.
  const db = readJSON(BOOKINGS_FILE, { bookings: [] });
  const rows = db.bookings || [];
  return rows.map((b) => ({
    ...b,
    createdAt: normalizeDateValueForApi(
      b.createdAt || b.created || b.created_at || b.timestamp || null
    ),
    updatedAt: normalizeDateValueForApi(b.updatedAt || b.updated || null),
    checkIn: normalizeDateValueForApi(
      b.checkIn || b.startDate || b.from || null
    ),
    checkOut: normalizeDateValueForApi(b.checkOut || b.endDate || b.to || null),
  }));
}

/* ───────────────────────────── ROUTER INIT ───────────────────────────── */

const router = Router();

/* ───────────────────────────── OVERVIEW ───────────────────────────── */

router.get("/overview", async (_req, res) => {
  try {
    const [users, listings, bookings, kycReqs] = await Promise.all([
      loadUsers(),
      loadListings(),
      loadBookings(),
      Promise.resolve(readJSON(KYC_FILE, { requests: [] }).requests || []),
    ]);

    const txCounts = bookings.reduce(
      (acc, b) => {
        const s = String(b.status || "pending").toLowerCase();
        acc.all++;
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      },
      { all: 0, pending: 0, confirmed: 0, cancelled: 0, refunded: 0 }
    );

    res.json({
      users: { total: users.length },
      listings: {
        active: listings.filter((l) => (l.status || "active") === "active").length,
      },
      transactions: { total: bookings.length, counts: txCounts },
      kyc: {
        pending: kycReqs.filter(
          (r) => (r.status || "pending").toLowerCase() === "pending"
        ).length,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load overview" });
  }
});

/* ───────────────────────────── USERS ───────────────────────────── */

router.get("/users", async (req, res) => {
  try {
    const { q = "", role = "all", status = "all", page = 1, limit = 10 } = req.query;

    let rows = await loadUsers();

    const kw = String(q).trim().toLowerCase();
    if (kw) {
      rows = rows.filter((u) =>
        `${u.name || ""} ${u.displayName || ""} ${u.email || ""} ${u.phone || ""}`
          .toLowerCase()
          .includes(kw)
      );
    }
    if (role !== "all") {
      rows = rows.filter(
        (u) => String(u.role || "guest").toLowerCase() === String(role).toLowerCase()
      );
    }
    if (status !== "all") {
      const wantSuspended = status === "suspended";
      rows = rows.filter((u) => Boolean(u.disabled) === wantSuspended);
    }

    const { items, total, page: p, limit: l } = paginate(rows, page, limit);
    res.json({ data: items, total, page: p, limit: l });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load users" });
  }
});

router.get("/users/export.csv", (req, res) => {
  try {
    const range = normalizeRange(req.query);
    let rows = readJSON(USERS_FILE, { users: [] }).users || [];

    const wantsFilter = req.query.from || req.query.to;
    if (wantsFilter) {
      rows = rows.filter((u) =>
        rowInRange(u, range, ["lastLoginAt", "createdAt", "updatedAt"])
      );
    }

    const header = ["id", "email", "name", "role", "disabled", "createdAt", "lastLoginAt"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const csv = [
      header.join(","),
      ...rows.map((u) =>
        [
          u.id,
          u.email,
          u.name || u.displayName || "",
          u.role || "guest",
          !!u.disabled,
          u.createdAt || "",
          u.lastLoginAt || "",
        ]
          .map(esc)
          .join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="users-${Date.now()}.csv"`
    );
    res.status(200).send(csv);
  } catch (e) {
    console.error("GET /admin/users/export.csv failed:", e);
    res.status(500).json({ error: "users_export_failed" });
  }
});

router.patch("/users/:id/role", (req, res) => {
  try {
    const id = String(req.params.id);
    const nextRole = String(req.body?.role || "").toLowerCase();
    const allowed = ["guest", "host", "partner", "admin"];
    if (!allowed.includes(nextRole)) {
      return res.status(400).json({ message: "Invalid role", allowed });
    }

    const db = readJSON(USERS_FILE, { users: [] });
    const idx = (db.users || []).findIndex((u) => String(u.id) === id);
    if (idx === -1) return res.status(404).json({ message: "User not found" });

    db.users[idx].role = nextRole;
    db.users[idx].updatedAt = new Date().toISOString();
    writeJSON(USERS_FILE, db);
    res.json({ ok: true, user: db.users[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to update role" });
  }
});

/* ───────────────────────────── BOOKINGS (ADMIN LIST + CSV) ───────────────────────────── */

router.get("/bookings", async (req, res) => {
  try {
    const { status = "all", q = "", page = 1, limit = 20 } = req.query;

    let rows = await loadBookings();

    // Status tab filter (pending / confirmed / cancelled / refunded / failed etc)
    if (status !== "all") {
      const want = String(status).toLowerCase();
      rows = rows.filter(
        (b) => String(b.status || "").toLowerCase() === want
      );
    }

    // Keyword filter (guest email, listing title, reference)
    const kw = String(q || "").trim().toLowerCase();
    if (kw) {
      rows = rows.filter((b) => {
        const email =
          (b.guestEmail || b.email || b.guest || "").toLowerCase();
        const title =
          (b.listingTitle || b.listing || b.title || "").toLowerCase();
        const ref =
          (b.reference || b.ref || b.id || b.bookingId || "").toLowerCase();
        return email.includes(kw) || title.includes(kw) || ref.includes(kw);
      });
    }

    // Sort newest → oldest by updatedAt / createdAt
    rows.sort((a, b) => {
      const ta = parseDateLoose(a.updatedAt || a.createdAt || 0)?.getTime() || 0;
      const tb = parseDateLoose(b.updatedAt || b.createdAt || 0)?.getTime() || 0;
      return tb - ta;
    });

    const { items, total, page: p, limit: l } = paginate(rows, page, limit);
    res.json({ data: items, total, page: p, limit: l });
  } catch (e) {
    console.error("GET /admin/bookings failed:", e);
    res.status(500).json({ error: "bookings_list_failed" });
  }
});

router.get("/bookings/export.csv", async (req, res) => {
  try {
    const range = normalizeRange(req.query);
    let bookings = await loadBookings();

    bookings = bookings.map((b) => ({
      id: b.id || "",
      listingId: b.listingId || b.listing || "",
      guestEmail: b.guestEmail || b.email || "",
      nights: Number(b.nights || b.nightCount || 0),
      amount: Number(
        b.amountN || b.amount || b.totalAmount || b.total || 0
      ),
      status: String(b.status || "").toLowerCase(),
      ref: b.ref || b.reference || b.id || "",
      createdAt: b.createdAt || "",
      updatedAt: b.updatedAt || "",
    }));

    const wantsFilter = req.query.from || req.query.to;
    if (wantsFilter) {
      bookings = bookings.filter((r) =>
        rowInRange(r, range, ["updatedAt", "createdAt"])
      );
    }

    const header = [
      "id",
      "listingId",
      "guestEmail",
      "nights",
      "amount",
      "status",
      "ref",
      "createdAt",
      "updatedAt",
    ];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const csvLines = [
      header.join(","),
      ...bookings.map((r) => header.map((k) => esc(r[k])).join(",")),
    ];

    const csv = csvLines.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bookings-${Date.now()}.csv"`
    );
    return res.send(csv);
  } catch (e) {
    console.error("GET /admin/bookings/export.csv failed:", e);
    res.status(500).json({ message: "Failed to export bookings CSV" });
  }
});

/* NOTE:
   We intentionally do NOT implement PATCH /admin/bookings/:id/status here.
   The admin UI already falls back to /api/bookings/:id/status, which is
   handled in routes/bookings.js and also logs payouts correctly.
*/

/* ───────────────────────────── KYC ───────────────────────────── */

router.get("/kyc", (req, res) => {
  try {
    const { status = "all", q = "", page = 1, limit = 10 } = req.query;
    let rows = readJSON(KYC_FILE, { requests: [] }).requests || [];

    if (status !== "all") {
      rows = rows.filter(
        (r) =>
          String(r.status || "pending").toLowerCase() ===
          String(status).toLowerCase()
      );
    }
    const kw = String(q).trim().toLowerCase();
    if (kw) {
      rows = rows.filter((r) =>
        `${r.name || ""} ${r.email || ""} ${r.userId || ""}`
          .toLowerCase()
          .includes(kw)
      );
    }
    rows.sort(
      (a, b) =>
        new Date(b.submittedAt || b.createdAt || 0) -
        new Date(a.submittedAt || a.createdAt || 0)
    );

    const { items, total, page: p, limit: l } = paginate(rows, page, limit);
    res.json({ data: items, total, page: p, limit: l });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load KYC requests" });
  }
});

router.get("/kyc/export.csv", (req, res) => {
  try {
    const { status = "all", q = "" } = req.query;
    const range = normalizeRange(req.query);

    let rows = readJSON(KYC_FILE, { requests: [] }).requests || [];

    if (status !== "all") {
      rows = rows.filter(
        (r) =>
          String(r.status || "pending").toLowerCase() ===
          String(status).toLowerCase()
      );
    }
    const kw = String(q).trim().toLowerCase();
    if (kw) {
      rows = rows.filter((r) =>
        `${r.name || ""} ${r.email || ""} ${r.userId || ""}`
          .toLowerCase()
          .includes(kw)
      );
    }

    const wantsFilter = req.query.from || req.query.to;
    if (wantsFilter) {
      rows = rows.filter((r) =>
        rowInRange(r, range, [
          "reviewedAt",
          "submittedAt",
          "updatedAt",
          "createdAt",
        ])
      );
    }

    const header = [
      "id",
      "userId",
      "name",
      "email",
      "phoneNumber",
      "status",
      "submittedAt",
      "reviewedAt",
    ];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const csv = [
      header.join(","),
      ...rows.map((r) =>
        [
          r.id,
          r.userId,
          r.name,
          r.email,
          r.phoneNumber,
          r.status,
          r.submittedAt,
          r.reviewedAt,
        ]
          .map(esc)
          .join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="kyc-${Date.now()}.csv"`
    );
    return res.status(200).send(csv);
  } catch (e) {
    console.error("GET /admin/kyc/export.csv failed:", e);
    return res.status(500).send("kyc_export_failed");
  }
});

router.get("/kyc/:id", (req, res) => {
  try {
    const { id } = req.params;
    const db = readJSON(KYC_FILE, { requests: [] });
    const row = (db.requests || []).find((r) => String(r.id) === String(id));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load request" });
  }
});

// KYC status + optional role assignment (same as before, left intact)
router.patch("/kyc/:id/status", async (req, res) => {
  try {
    const { id } = req.params;

    const next = String(req.body?.status || "").toLowerCase(); // approved | rejected | pending
    const note = String(req.body?.note || "");
    const assignRoleRaw = req.body?.assignRole;
    const assignRole = assignRoleRaw ? String(assignRoleRaw).toLowerCase() : "";

    const allowedStatus = ["approved", "rejected", "pending"];
    const allowedRoles = ["guest", "host", "partner", "admin", ""]; // "" = no role change

    if (!allowedStatus.includes(next)) {
      return res.status(400).json({ message: "Invalid status", allowedStatus });
    }
    if (!allowedRoles.includes(assignRole)) {
      return res.status(400).json({ message: "Invalid assignRole", allowedRoles });
    }

    const db = readJSON(KYC_FILE, { requests: [] });
    const idx = (db.requests || []).findIndex(
      (r) => String(r.id) === String(id)
    );
    if (idx === -1) return res.status(404).json({ message: "Request not found" });

    const now = new Date().toISOString();
    const row = db.requests[idx];
    row.status = next;
    row.reviewedAt = now;
    row.updatedAt = now;
    row.history = row.history || [];
    row.history.push({
      at: now,
      status: next,
      note,
      by: "admin",
      assignRole: assignRole || undefined,
    });
    db.requests[idx] = row;
    writeJSON(KYC_FILE, db);

    const userId = row.userId ? String(row.userId) : null;

    // mirror to users.json
    if (userId) {
      const usersDb = readJSON(USERS_FILE, { users: [] });
      const ui = (usersDb.users || []).findIndex(
        (u) => String(u.id) === userId
      );
      if (ui !== -1) {
        const u = usersDb.users[ui];
        u.kycStatus = next;
        u.updatedAt = now;
        if (assignRole && ["guest", "host", "partner", "admin"].includes(assignRole)) {
          u.role = assignRole;
        }
        usersDb.users[ui] = u;
        writeJSON(USERS_FILE, usersDb);
      }
    }

    // mirror to onboarding + Firestore user doc (kept from your previous logic)
    if (userId) {
      const ob = readJSON(ONBOARD_FILE, { host: [], partner: [] });
      const kinds = ["host", "partner"];
      let changed = false;

      for (const kind of kinds) {
        const list = ob[kind] || [];
        for (let i = 0; i < list.length; i++) {
          if (String(list[i].userId) !== userId) continue;

          if (next === "rejected") {
            list[i].status = "rejected";
          } else if (next === "approved" && assignRole === kind) {
            list[i].status = "approved";
          } else if (next === "pending") {
            list[i].status = "under_review";
          }
          list[i].updatedAt = now;
          changed = true;
        }
        ob[kind] = list;
      }
      if (changed) writeJSON(ONBOARD_FILE, ob);
    }

    if (fdb && userId) {
      try {
        const docRef = fdb.collection("users").doc(userId);
        const payload = {
          kycStatus: next,
          updatedAt: now,
        };
        if (assignRole && ["guest", "host", "partner", "admin"].includes(assignRole)) {
          payload.role = assignRole;
        }
        await docRef.set(payload, { merge: true });
      } catch (fireErr) {
        console.error("Firestore sync failed for KYC update:", fireErr);
      }
    }

    return res.json({
      ok: true,
      data: row,
      assignedRole: assignRole || undefined,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to update KYC" });
  }
});

/* ───────────────────────────── LISTINGS ───────────────────────────── */

router.get("/listings", async (req, res) => {
  try {
    const {
      q = "",
      city = "",
      status = "all",
      grade = "all",
      featured = "all",
      page = 1,
      limit = 12,
    } = req.query;

    let rows = await loadListings();

    const kw = String(q).trim().toLowerCase();
    if (kw) {
      rows = rows.filter((l) =>
        `${l.title || ""} ${l.city || ""} ${l.area || ""} ${l.type || ""}`
          .toLowerCase()
          .includes(kw)
      );
    }
    if (city) {
      const c = String(city).toLowerCase();
      rows = rows.filter((l) => (l.city || "").toLowerCase() === c);
    }
    if (status !== "all") {
      rows = rows.filter(
        (l) =>
          String(l.status || "active").toLowerCase() ===
          String(status).toLowerCase()
      );
    }
    if (grade !== "all") {
      rows = rows.filter((l) => (l.grade || "Standard") === grade);
    }
    if (featured !== "all") {
      const want = featured === "true";
      rows = rows.filter((l) => Boolean(l.featured) === want);
    }

    rows.sort((a, b) => {
      const ta =
        parseDateLoose(a.updatedAt || a.createdAt || 0)?.getTime() || 0;
      const tb =
        parseDateLoose(b.updatedAt || b.createdAt || 0)?.getTime() || 0;
      return tb - ta;
    });

    const { items, total, page: p, limit: l } = paginate(rows, page, limit);
    res.json({ data: items, total, page: p, limit: l });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load listings" });
  }
});

router.get("/listings/export.csv", (req, res) => {
  try {
    const range = normalizeRange(req.query);
    let rows = readJSON(LISTINGS_FILE, { listings: [] }).listings || [];

    const wantsFilter = req.query.from || req.query.to;
    if (wantsFilter) {
      rows = rows.filter((r) =>
        rowInRange(r, range, ["updatedAt", "createdAt"])
      );
    }

    const head = [
      "id",
      "title",
      "city",
      "area",
      "type",
      "pricePerNight",
      "status",
      "featured",
      "grade",
      "gradeNote",
      "updatedAt",
    ];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const csv = [
      head.join(","),
      ...rows.map((r) =>
        [
          r.id,
          r.title,
          r.city,
          r.area,
          r.type,
          r.pricePerNight,
          r.status,
          r.featured,
          r.grade || "",
          r.gradeNote || "",
          r.updatedAt || r.createdAt || "",
        ]
          .map(esc)
          .join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=listings.csv"
    );
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to export CSV" });
  }
});

router.get("/listing/:id", (req, res) => {
  try {
    const { id } = req.params;
    const db = readJSON(LISTINGS_FILE, { listings: [] });
    const item = (db.listings || []).find((l) => String(l.id) === String(id));
    if (!item) return res.status(404).json({ message: "Listing not found" });
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to fetch listing" });
  }
});

router.patch("/listings/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { status, featured, grade, qualityNote, flagged } = req.body || {};
    const db = readJSON(LISTINGS_FILE, { listings: [] });
    const idx = (db.listings || []).findIndex(
      (l) => String(l.id) === String(id)
    );
    if (idx === -1) return res.status(404).json({ message: "Listing not found" });

    if (typeof status === "string") {
      const normalized = String(status).toLowerCase();
      if (!["active", "inactive", "review"].includes(normalized)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      db.listings[idx].status = normalized;
    }
    if (typeof featured !== "undefined") db.listings[idx].featured = !!featured;
    if (typeof grade === "string") db.listings[idx].grade = grade;
    if (typeof qualityNote === "string")
      db.listings[idx].qualityNote = qualityNote;
    if (typeof flagged !== "undefined") db.listings[idx].flagged = !!flagged;

    db.listings[idx].updatedAt = new Date().toISOString();
    writeJSON(LISTINGS_FILE, db);
    res.json({ ok: true, data: db.listings[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to update listing" });
  }
});

router.patch("/listings/:id/grade", (req, res) => {
  try {
    const { id } = req.params;
    const { grade, note } = req.body || {};
    const allowed = ["Elite", "Premium", "Standard", "Needs Improvement", "Rejected"];
    if (!allowed.includes(grade)) {
      return res.status(400).json({ message: "Invalid grade", allowed });
    }
    const db = readJSON(LISTINGS_FILE, { listings: [] });
    const idx = (db.listings || []).findIndex(
      (l) => String(l.id) === String(id)
    );
    if (idx === -1) return res.status(404).json({ message: "Listing not found" });

    db.listings[idx].grade = grade;
    if (typeof note === "string") db.listings[idx].gradeNote = note;
    db.listings[idx].updatedAt = new Date().toISOString();
    writeJSON(LISTINGS_FILE, db);
    res.json({ ok: true, data: db.listings[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to grade listing" });
  }
});

router.patch("/listings/:id/featured", (req, res) => {
  try {
    const { id } = req.params;
    const featured = !!req.body?.featured;
    const db = readJSON(LISTINGS_FILE, { listings: [] });
    const idx = (db.listings || []).findIndex(
      (l) => String(l.id) === String(id)
    );
    if (idx === -1) return res.status(404).json({ message: "Listing not found" });

    db.listings[idx].featured = featured;
    db.listings[idx].updatedAt = new Date().toISOString();
    writeJSON(LISTINGS_FILE, db);
    res.json({ ok: true, data: db.listings[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to update featured flag" });
  }
});

router.delete("/listings/:id", (req, res) => {
  try {
    const { id } = req.params;
    const db = readJSON(LISTINGS_FILE, { listings: [] });
    const before = db.listings?.length || 0;
    db.listings = (db.listings || []).filter(
      (l) => String(l.id) !== String(id)
    );
    writeJSON(LISTINGS_FILE, db);
    const after = db.listings.length;
    if (after === before)
      return res.status(404).json({ message: "Listing not found" });
    res.json({ ok: true, removed: id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to delete listing" });
  }
});

/* ───────────────────────────── PAYOUTS ───────────────────────────── */

function createPayout({ payeeEmail, payeeType = "host", amount, ref, note = "" }) {
  const db = readJSON(PAYOUTS_FILE, { payouts: [] });
  const id = `po_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  const now = new Date().toISOString();
  const row = {
    id,
    date: now,
    payeeEmail: String(payeeEmail || "-"),
    payeeType: String(payeeType || "host"),
    amount: Number(amount || 0),
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

/**
 * Build a combined payouts view:
 *  - existing rows from payouts.json
 *  - plus synthetic rows for refunded Firestore bookings that don't
 *    yet have a payout entry.
 */
async function buildPayoutRows() {
  const fileDb = readJSON(PAYOUTS_FILE, { payouts: [] });
  const payouts = (fileDb.payouts || []).slice(); // clone

  // normalise dates already in payouts.json
  for (const p of payouts) {
    p.date = normalizeDateValueForApi(p.date || p.createdAt || p.updatedAt);
    p.createdAt = normalizeDateValueForApi(p.createdAt || p.date);
    p.updatedAt = normalizeDateValueForApi(p.updatedAt || p.date);
  }

  // Helper: does this payout already exist for a given booking?
  function hasPayoutForBooking(b) {
    const bid = String(b.id || b.bookingId || "");
    const bref = String(b.reference || b.ref || "");
    return payouts.some((p) => {
      const r = String(p.ref || "");
      return (
        (bid && r.includes(bid)) ||
        (bref && r === bref)
      );
    });
  }

  // Pull the latest bookings from Firestore
  const bookings = await loadBookings();
  const nowIso = new Date().toISOString();

  for (const b of bookings) {
    const status = String(b.status || "").toLowerCase();
    if (status !== "refunded") continue; // only care about refunds here

    if (hasPayoutForBooking(b)) continue; // already logged

    const gross =
      Number(
        b.total ||
          b.amountN ||
          b.amount ||
          b.totalAmount ||
          0
      ) || 0;

    const hostShare = Math.round(gross * 0.9); // host’s 90%
    const refundAmount = -hostShare;           // negative for refund

    const hostEmail =
      b.hostEmail ||
      b.ownerEmail ||
      b.payeeEmail ||
      b.listingOwner ||
      "host@nesta.dev";

    const ref =
      b.reference ||
      b.ref ||
      (b.id ? `NESTA_${b.id}` : "");

    const dateRaw = b.updatedAt || b.createdAt || nowIso;

    const row = {
      id: `syn_refund_${b.id || ref || Date.now()}`,
      date: normalizeDateValueForApi(dateRaw),
      payeeEmail: hostEmail,
      payeeType: "host",
      amount: refundAmount,
      currency: "NGN",
      status: "pending",
      ref,
      note: "Synthetic payout from refunded booking",
      createdAt: normalizeDateValueForApi(dateRaw),
      updatedAt: nowIso,
      _source: "synthetic",
    };

    payouts.unshift(row);
  }

  return payouts;
}

router.get("/payouts", async (req, res) => {
  try {
    const { tab = "all", q = "" } = req.query;
    let rows = await buildPayoutRows();

    if (tab && tab !== "all") {
      rows = rows.filter(
        (r) =>
          String(r.status || "")
            .toLowerCase() === String(tab).toLowerCase()
      );
    }

    const kw = String(q || "").trim().toLowerCase();
    if (kw) {
      rows = rows.filter(
        (r) =>
          (r.payeeEmail || "").toLowerCase().includes(kw) ||
          (r.ref || "").toLowerCase().includes(kw)
      );
    }

    res.json({ data: rows });
  } catch (e) {
    console.error("GET /admin/payouts failed:", e);
    res.status(500).json({ error: "payouts_list_failed" });
  }
});

router.get("/payouts/export.csv", async (req, res) => {
  try {
    const { tab = "all", q = "" } = req.query;
    const range = normalizeRange(req.query);

    let rows = await buildPayoutRows();

    if (tab && tab !== "all") {
      rows = rows.filter(
        (r) =>
          String(r.status || "")
            .toLowerCase() === String(tab).toLowerCase()
      );
    }

    const kw = String(q || "").trim().toLowerCase();
    if (kw) {
      rows = rows.filter(
        (r) =>
          (r.payeeEmail || "").toLowerCase().includes(kw) ||
          (r.ref || "").toLowerCase().includes(kw)
      );
    }

    const wantsFilter = req.query.from || req.query.to;
    if (wantsFilter) {
      rows = rows.filter((r) =>
        rowInRange(r, range, ["updatedAt", "createdAt", "date"])
      );
    }

    const header = [
      "id",
      "date",
      "payeeEmail",
      "payeeType",
      "amount",
      "status",
      "ref",
    ];
    const esc = (v) =>
      `"${String(v ?? "").replace(/"/g, '""')}"`;

    const csv = [
      header.join(","),
      ...rows.map((r) =>
        header.map((k) => esc(r[k])).join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv;charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="payouts-${Date.now()}.csv"`
    );
    res.send(csv);
  } catch (e) {
    console.error("GET /admin/payouts/export.csv failed:", e);
    res.status(500).json({ error: "payouts_export_failed" });
  }
});

router.patch("/payouts/:id/status", (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body?.status || "").toLowerCase();
    const allowed = ["pending", "processing", "paid", "failed"];
    if (!allowed.includes(status))
      return res.status(400).json({ error: "Invalid status" });

    const db = readJSON(PAYOUTS_FILE, { payouts: [] });
    const idx = (db.payouts || []).findIndex(
      (p) => String(p.id) === String(id)
    );
    if (idx === -1)
      return res.status(404).json({ error: "Not found" });

    db.payouts[idx].status = status;
    db.payouts[idx].updatedAt = new Date().toISOString();
    writeJSON(PAYOUTS_FILE, db);

    res.json({ ok: true, item: db.payouts[idx] });
  } catch (e) {
    console.error(
      "PATCH /admin/payouts/:id/status failed:",
      e
    );
    res.status(500).json({ error: "payouts_update_failed" });
  }
});

/* ───────────────────────────── FEATURE REQUESTS ───────────────────────────── */

router.get("/feature-requests", (req, res) => {
  try {
    const { status = "all", q = "" } = req.query;
    let list = readJSON(FEATURE_FILE, { requests: [] }).requests || [];

    if (status !== "all") {
      list = list.filter(
        (r) =>
          String(r.status || "pending").toLowerCase() ===
          String(status).toLowerCase()
      );
    }
    const kw = String(q).trim().toLowerCase();
    if (kw) {
      list = list.filter((r) =>
        `${r.title || ""} ${r.by || ""} ${r.id || ""}`
          .toLowerCase()
          .includes(kw)
      );
    }
    res.json({ data: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load feature requests" });
  }
});

router.patch("/feature-requests/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { status, priority } = req.body || {};
    const db = readJSON(FEATURE_FILE, { requests: [] });
    const idx = (db.requests || []).findIndex(
      (r) => String(r.id) === String(id)
    );
    if (idx === -1) return res.status(404).json({ message: "Request not found" });

    if (status) db.requests[idx].status = status;
    if (priority) db.requests[idx].priority = priority;
    db.requests[idx].updatedAt = new Date().toISOString();
    writeJSON(FEATURE_FILE, db);

    res.json({ ok: true, data: db.requests[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to update feature request" });
  }
});

/* ───────────────────────────── SETTINGS ───────────────────────────── */

router.get("/settings", (_req, res) => {
  try {
    const cfg = readJSON(SETTINGS_FILE, {
      maintenanceMode: false,
      requireKycForNewHosts: true,
      featuredCarouselLimit: 10,
      updatedAt: new Date().toISOString(),
    });
    res.json(cfg);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load settings" });
  }
});

router.put("/settings", (req, res) => {
  try {
    const current = readJSON(SETTINGS_FILE, {});
    const next = {
      ...current,
      maintenanceMode: !!req.body?.maintenanceMode,
      requireKycForNewHosts: !!req.body?.requireKycForNewHosts,
      featuredCarouselLimit: Number(
        req.body?.featuredCarouselLimit ??
          current.featuredCarouselLimit ??
          10
      ),
      updatedAt: new Date().toISOString(),
    };
    writeJSON(SETTINGS_FILE, next);
    res.json(next);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to save settings" });
  }
});

export default router;
