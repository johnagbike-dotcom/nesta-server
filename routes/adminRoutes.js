// routes/adminRoutes.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ───────────────────────────── SAFE OPTIONAL FIREBASE ADMIN ─────────────────────────────
   We *try* to load ../firebaseAdmin.js. If the file isn't present, we just skip Firestore
   wiring and continue with local JSON storage. No crashes.
----------------------------------------------------------------------------------------- */
let fdb = null; // Firestore (if available)
try {
  const adminMod = await import("../firebaseAdmin.js"); // optional
  const admin = adminMod?.default || adminMod;
  if (admin?.apps?.length) {
    const fa = await import("firebase-admin/firestore");
    fdb = fa.getFirestore();
  }
} catch {
  // No firebaseAdmin.js or firebase-admin not installed: proceed without Firestore.
}
/* ───────────── Date helpers (strings | numbers | Firestore Timestamp) ───────────── */
const toDate = (v) => {
  if (!v) return null;
  if (v.toDate) return v.toDate();                 // Firestore Timestamp
  if (typeof v === "number") return new Date(v);   // ms since epoch
  const d = new Date(v);                           // ISO string
  return isNaN(d) ? null : d;
};

// Parse ?from=&to= (inclusive on the 'to' day)
const parseRange = (from, to) => {
  const f = from ? new Date(from) : null;
  const t = to ? new Date(to) : null;
  if (t) t.setHours(23, 59, 59, 999);              // include whole 'to' day
  return { from: isNaN(f) ? null : f, to: isNaN(t) ? null : t };
};

const inRange = (date, from, to) => {
  if (!from && !to) return true;
  const d = toDate(date);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
};
/* ─────────────── Date helpers for CSV/list filtering (single-init) ─────────────── */
const {
  parseDateLoose,
  normalizeRange,
  getWhenMs,
} = (() => {
  // Reuse on hot-reload to avoid “Identifier has already been declared”
  if (globalThis.__nestaDateHelpers) return globalThis.__nestaDateHelpers;

  function parseDateLoose(v) {
    if (!v) return null;
    if (typeof v === "number") return new Date(v);                 // epoch ms
    if (typeof v === "string") {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v;
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : d;
    }
    if (v && typeof v.toDate === "function") return v.toDate();    // Firestore Timestamp
    const d = new Date(v);                                         // generic object/Date
    return isNaN(d.getTime()) ? null : d;
  }

  function normalizeRange(q = {}) {
    const fromD = parseDateLoose(q.from);
    const toD   = parseDateLoose(q.to);

    let toAdj = toD ? new Date(toD) : null;
    if (toAdj && /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || ""))) {
      // include the whole “to” day
      toAdj.setUTCHours(23, 59, 59, 999);
    }
    return [fromD ? fromD.getTime() : null, toAdj ? toAdj.getTime() : null];
  }

  function getWhenMs(
    row,
    fields = ["updatedAt","createdAt","submittedAt","reviewedAt","lastLoginAt"]
  ) {
    let best = null;
    for (const f of fields) {
      const d = parseDateLoose(row?.[f]);
      if (!d) continue;
      const ms = d.getTime();
      if (best == null || ms > best) best = ms;
    }
    return best; // may be null
  }

  function inRange(row, range, customFields) {
    const [fromMs, toMs] = range;
    const ms = getWhenMs(row, customFields);
    if (ms == null) return false;
    if (fromMs != null && ms < fromMs) return false;
    if (toMs   != null && ms > toMs)   return false;
    return true;
  }

  globalThis.__nestaDateHelpers = { parseDateLoose, normalizeRange, getWhenMs, inRange };
  return globalThis.__nestaDateHelpers;
})(); // ← don't remove this

/* ───────────────────────────────────── Setup ───────────────────────────────────── */
const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");

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
const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const paginate = (arr, page = 1, limit = 10) => {
  const p = Math.max(1, toInt(page, 1));
  const l = Math.max(1, toInt(limit, 10));
  const start = (p - 1) * l;
  return { items: arr.slice(start, start + l), page: p, limit: l, total: arr.length };
};

/* ─────────────────────────── Data files ────────────────────────── */
const USERS_FILE     = path.join(DATA_DIR, "users.json");            // { users: [] }
const LISTINGS_FILE  = path.join(DATA_DIR, "listings.json");         // { listings: [] }
const BOOKINGS_FILE  = path.join(DATA_DIR, "bookings.json");         // { bookings: [] }
const KYC_FILE       = path.join(DATA_DIR, "kyc.json");              // { requests: [] }
const FEATURE_FILE   = path.join(DATA_DIR, "featureRequests.json");  // { requests: [] }
const PAYOUTS_FILE   = path.join(DATA_DIR, "payouts.json");          // { payouts: [] }
const SETTINGS_FILE  = path.join(DATA_DIR, "settings.json");
const ONBOARD_FILE   = path.join(DATA_DIR, "onboarding.json");       // { host: [], partner: [] }


ensureFile(USERS_FILE,    { users: [] });
ensureFile(LISTINGS_FILE, { listings: [] });
ensureFile(BOOKINGS_FILE, { bookings: [] });
ensureFile(KYC_FILE,      { requests: [] });
ensureFile(FEATURE_FILE,  { requests: [] });
ensureFile(PAYOUTS_FILE,  { payouts: [] });
ensureFile(ONBOARD_FILE,  { host: [], partner: [] });
ensureFile(SETTINGS_FILE, {
  maintenanceMode: false,
  requireKycForNewHosts: true,
  featuredCarouselLimit: 10,
  updatedAt: new Date().toISOString(),
});

/* ─────────────────────────── Overview ──────────────────────────── */
router.get("/overview", (_req, res) => {
  try {
    const users    = readJSON(USERS_FILE, { users: [] }).users || [];
    const listings = readJSON(LISTINGS_FILE, { listings: [] }).listings || [];
    const bookings = readJSON(BOOKINGS_FILE, { bookings: [] }).bookings || [];
    const kycReqs  = readJSON(KYC_FILE, { requests: [] }).requests || [];

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
      listings: { active: listings.filter((l) => (l.status || "active") === "active").length },
      transactions: { total: bookings.length, counts: txCounts },
      kyc: { pending: kycReqs.filter((r) => (r.status || "pending") === "pending").length },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load overview" });
  }
});

/* ─────────────────────────── Users ─────────────────────────────── */
router.get("/users", (req, res) => {
  try {
    const { q = "", role = "all", status = "all", page = 1, limit = 10 } = req.query;
    let rows = readJSON(USERS_FILE, { users: [] }).users || [];

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
// --- USERS: CSV export -------------------------------------------------
router.get("/users/export.csv", (req, res) => {
  try {
    const range = normalizeRange(req.query);
    let rows = readJSON(USERS_FILE, { users: [] }).users || [];

    // Apply date range if provided (createdAt/lastLoginAt)
    const wantsFilter = req.query.from || req.query.to;
    if (wantsFilter) {
      rows = rows.filter((u) =>
        inRange(u, range, ["lastLoginAt", "createdAt", "updatedAt"])
      );
    }

    const header = ["id","email","name","role","disabled","createdAt","lastLoginAt"];
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
        ].map(esc).join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="users-${Date.now()}.csv"`);
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

/* ─────────────────────────── KYC ──────────────────────────────── */
router.get("/kyc", (req, res) => {
  try {
    const { status = "all", q = "", page = 1, limit = 10 } = req.query;
    let rows = readJSON(KYC_FILE, { requests: [] }).requests || [];

    if (status !== "all") {
      rows = rows.filter(
        (r) => String(r.status || "pending").toLowerCase() === String(status).toLowerCase()
      );
    }
    const kw = String(q).trim().toLowerCase();
    if (kw) {
      rows = rows.filter((r) =>
        `${r.name || ""} ${r.email || ""} ${r.userId || ""}`.toLowerCase().includes(kw)
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

    let rows = (readJSON(KYC_FILE, { requests: [] }).requests || []);

    if (status !== "all") {
      rows = rows.filter(r => String(r.status || "pending").toLowerCase() === status.toLowerCase());
    }
    const kw = String(q).trim().toLowerCase();
    if (kw) {
      rows = rows.filter(r => `${r.name||""} ${r.email||""} ${r.userId||""}`.toLowerCase().includes(kw));
    }

    const wantsFilter = req.query.from || req.query.to;
    if (wantsFilter) {
      rows = rows.filter(r => inRange(r, range, ["reviewedAt","submittedAt","updatedAt","createdAt"]));
    }

    const header = ["id","userId","name","email","phoneNumber","status","submittedAt","reviewedAt"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const csv = [
      header.join(","),
      ...rows.map(r =>
        [
          r.id, r.userId, r.name, r.email, r.phoneNumber,
          r.status, r.submittedAt, r.reviewedAt
        ].map(esc).join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="kyc-${Date.now()}.csv"`);
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

router.patch("/kyc/:id/status", async (req, res) => {
  try {
    const { id } = req.params;

    const next = String(req.body?.status || "").toLowerCase();   // approved | rejected | pending
    const note = String(req.body?.note || "");
    const assignRoleRaw = req.body?.assignRole;
    const assignRole = assignRoleRaw ? String(assignRoleRaw).toLowerCase() : "";

    const allowedStatus = ["approved", "rejected", "pending"];
    const allowedRoles  = ["guest", "host", "partner", "admin", ""]; // "" = no role change

    if (!allowedStatus.includes(next)) {
      return res.status(400).json({ message: "Invalid status", allowedStatus });
    }
    if (!allowedRoles.includes(assignRole)) {
      return res.status(400).json({ message: "Invalid assignRole", allowedRoles });
    }

    const db = readJSON(KYC_FILE, { requests: [] });
    const idx = (db.requests || []).findIndex((r) => String(r.id) === String(id));
    if (idx === -1) return res.status(404).json({ message: "Request not found" });

    const now = new Date().toISOString();
    const row = db.requests[idx];
    row.status = next;
    row.reviewedAt = now;
    row.updatedAt = now;
    row.history = row.history || [];
    row.history.push({ at: now, status: next, note, by: "admin", assignRole: assignRole || undefined });
    db.requests[idx] = row;
    writeJSON(KYC_FILE, db);

    const userId = row.userId ? String(row.userId) : null;

    /* ───────────── Update local users.json ───────────── */
    if (userId) {
      const usersDb = readJSON(USERS_FILE, { users: [] });
      const ui = (usersDb.users || []).findIndex((u) => String(u.id) === userId);
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

    /* ───────────── Update onboarding.json (host/partner apps) ───────────── */
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

    /* ───────────── Optional: Firestore user doc ───────────── */
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
        // We don't fail the whole request if Firestore write fails.
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


/* ─────────────── Bookings export (CSV) ─────────────── */
router.get("/bookings/export.csv", (req, res) => {
  try {
    const range = normalizeRange(req.query);
    let bookings = (readJSON(BOOKINGS_FILE, { bookings: [] }).bookings || []).map(b => ({
      id: b.id || "",
      listingId: b.listingId || b.listing || "",
      guestEmail: b.guestEmail || b.email || "",
      nights: Number(b.nights || 0),
      amount: Number(b.amount || b.totalAmount || 0),
      status: b.status || "",
      ref: b.ref || b.reference || b.id || "",
      createdAt: b.createdAt || "",
      updatedAt: b.updatedAt || ""
    }));

    const wantsFilter = req.query.from || req.query.to;
    if (wantsFilter) {
      bookings = bookings.filter((r) => inRange(r, range, ["updatedAt","createdAt"]));
    }

    const header = ["id","listingId","guestEmail","nights","amount","status","ref","createdAt","updatedAt"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g,'""')}"`;

    const csv = [
      header.join(","),
      ...bookings.map(r => header.map(k => esc(r[k])).join(","))
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="bookings-${Date.now()}.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to export bookings CSV" });
  }
});

/* ───────────────────────── Listings ───────────────────────────── */
router.get("/listings", (req, res) => {
  try {
    const { q = "", city = "", status = "all", grade = "all", featured = "all", page = 1, limit = 12 } = req.query;

    let rows = readJSON(LISTINGS_FILE, { listings: [] }).listings || [];

    const kw = String(q).trim().toLowerCase();
    if (kw) {
      rows = rows.filter((l) =>
        `${l.title || ""} ${l.city || ""} ${l.area || ""} ${l.type || ""}`.toLowerCase().includes(kw)
      );
    }
    if (city) {
      const c = String(city).toLowerCase();
      rows = rows.filter((l) => (l.city || "").toLowerCase() === c);
    }
    if (status !== "all") rows = rows.filter((l) => String(l.status || "active").toLowerCase() === String(status).toLowerCase());
    if (grade !== "all") rows = rows.filter((l) => (l.grade || "Standard") === grade);
    if (featured !== "all") {
      const want = featured === "true";
      rows = rows.filter((l) => Boolean(l.featured) === want);
    }

    rows.sort((a, b) => {
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
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
      rows = rows.filter((r) => inRange(r, range, ["updatedAt", "createdAt"]));
    }

    const head = [
      "id","title","city","area","type","pricePerNight",
      "status","featured","grade","gradeNote","updatedAt",
    ];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const csv = [
      head.join(","),
      ...rows.map((r) =>
        [
          r.id, r.title, r.city, r.area, r.type, r.pricePerNight,
          r.status, r.featured, r.grade || "", r.gradeNote || "",
          r.updatedAt || r.createdAt || "",
        ].map(esc).join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=listings.csv");
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
    const idx = (db.listings || []).findIndex((l) => String(l.id) === String(id));
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
    if (typeof qualityNote === "string") db.listings[idx].qualityNote = qualityNote;
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
    const idx = (db.listings || []).findIndex((l) => String(l.id) === String(id));
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
    const idx = (db.listings || []).findIndex((l) => String(l.id) === String(id));
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
    db.listings = (db.listings || []).filter((l) => String(l.id) !== String(id));
    writeJSON(LISTINGS_FILE, db);
    const after = db.listings.length;
    if (after === before) return res.status(404).json({ message: "Listing not found" });
    res.json({ ok: true, removed: id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to delete listing" });
  }
});

/* ───────────────── Bookings -> Status + Payout ────────────────── */
function createPayout({ payeeEmail, payeeType = "host", amount, ref, note = "" }) {
  const db = readJSON(PAYOUTS_FILE, { payouts: [] });
  const id = `po_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  const now = new Date().toISOString();
  const row = {
    id, date: now, payeeEmail: String(payeeEmail || "-"),
    payeeType: String(payeeType || "host"), amount: Number(amount || 0),
    currency: "NGN", status: "pending", ref: String(ref || id), note,
    createdAt: now, updatedAt: now,
  };
  db.payouts = db.payouts || [];
  db.payouts.unshift(row);
  writeJSON(PAYOUTS_FILE, db);
  return row;
}

router.patch("/bookings/:id/status", (req, res) => {
  try {
    const { id } = req.params;
    const nextStatus = String(req.body?.status || "").toLowerCase(); // ✅ defined
    const allowed = ["pending", "confirmed", "cancelled", "refunded"];
    if (!allowed.includes(nextStatus)) {
      return res.status(400).json({ error: "bad_status", allowed });
    }

    const db = readJSON(BOOKINGS_FILE, { bookings: [] });
    const idx = (db.bookings || []).findIndex((b) => String(b.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: "not_found" });

    const now = new Date().toISOString();
    db.bookings[idx].status = nextStatus;
    db.bookings[idx].updatedAt = now;
    writeJSON(BOOKINGS_FILE, db);

    if (nextStatus === "confirmed") {
      const booking = db.bookings[idx];
      const hostEmail = booking.hostEmail || booking.ownerEmail || booking.payeeEmail || "host@nesta.dev";
      const gross = Number(booking.totalAmount || booking.amount || 0);
      const hostShare = Math.round(gross * 0.9);
      createPayout({
        payeeEmail: hostEmail,
        payeeType: "host",
        amount: hostShare,
        ref: `bo_${id}`,
        note: "Auto-payout from booking confirmation",
      });
    }

    res.json({ ok: true, status: nextStatus });
  } catch (e) {
    console.error("PATCH /bookings/:id/status failed:", e);
    res.status(500).json({ error: "update_failed" });
  }
});

/* ────────────────────────── Payouts ───────────────────────────── */
router.get("/payouts", (req, res) => {
  try {
    const { tab = "all", q = "" } = req.query;
    let rows = readJSON(PAYOUTS_FILE, { payouts: [] }).payouts || [];

    if (tab && tab !== "all") {
      rows = rows.filter((r) => String(r.status || "").toLowerCase() === String(tab).toLowerCase());
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
router.get("/payouts/export.csv", (req, res) => {
  try {
    const { tab = "all", q = "" } = req.query;
    const range = normalizeRange(req.query);

    let rows = readJSON(PAYOUTS_FILE, { payouts: [] }).payouts || [];

    if (tab && tab !== "all") {
      rows = rows.filter(r => String(r.status || "").toLowerCase() === String(tab).toLowerCase());
    }
    const kw = String(q || "").trim().toLowerCase();
    if (kw) {
      rows = rows.filter(r =>
        (r.payeeEmail || "").toLowerCase().includes(kw) ||
        (r.ref || "").toLowerCase().includes(kw)
      );
    }

    const wantsFilter = req.query.from || req.query.to;
    if (wantsFilter) {
      rows = rows.filter(r => inRange(r, range, ["updatedAt","createdAt","date"]));
    }

    const header = ["id","date","payeeEmail","payeeType","amount","status","ref"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const csv = [
      header.join(","),
      ...rows.map(r => header.map(k => esc(r[k])).join(",")),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv;charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="payouts-${Date.now()}.csv"`);
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
    if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });

    const db = readJSON(PAYOUTS_FILE, { payouts: [] });
    const idx = (db.payouts || []).findIndex((p) => String(p.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: "Not found" });

    db.payouts[idx].status = status;
    db.payouts[idx].updatedAt = new Date().toISOString();
    writeJSON(PAYOUTS_FILE, db);

    res.json({ ok: true, item: db.payouts[idx] });
  } catch (e) {
    console.error("PATCH /admin/payouts/:id/status failed:", e);
    res.status(500).json({ error: "payouts_update_failed" });
  }
});

/* ───────────────────── Feature Requests ───────────────────────── */
router.get("/feature-requests", (req, res) => {
  try {
    const { status = "all", q = "" } = req.query;
    let list = readJSON(FEATURE_FILE, { requests: [] }).requests || [];

    if (status !== "all") {
      list = list.filter(
        (r) => String(r.status || "pending").toLowerCase() === String(status).toLowerCase()
      );
    }
    const kw = String(q).trim().toLowerCase();
    if (kw) {
      list = list.filter((r) =>
        `${r.title || ""} ${r.by || ""} ${r.id || ""}`.toLowerCase().includes(kw)
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
    const idx = (db.requests || []).findIndex((r) => String(r.id) === String(id));
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

/* ───────────────────────── Settings ───────────────────────────── */
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
        req.body?.featuredCarouselLimit ?? current.featuredCarouselLimit ?? 10
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
