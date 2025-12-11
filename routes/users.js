// routes/users.js  (ESM) — Firebase-backed admin users API
import { Router } from "express";
import admin from "firebase-admin";

const router = Router();
const auth = admin.auth();
const db   = admin.firestore();

/* ----------------------------- helpers ----------------------------- */

function toRow(authUser, profile) {
  const role =
    (profile?.role || authUser?.customClaims?.role || "guest").toLowerCase();

  return {
    id: authUser.uid,
    name: profile?.name || authUser.displayName || "-",
    email: (authUser.email || profile?.email || "-").toLowerCase(),
    phone: profile?.phone || authUser.phoneNumber || "-",
    role,
    admin: role === "admin",
    disabled: !!authUser.disabled,
    createdAt: authUser.metadata?.creationTime || null,
    lastLogin: authUser.metadata?.lastSignInTime || null,
  };
}

function applyFilters(rows, { role = "all", status = "all", q = "" }) {
  let list = rows.slice();

  // role filter
  if (role && role !== "all") {
    const want = String(role).toLowerCase();
    list = list.filter((r) => r.role === want);
  }

  // status filter
  if (status && status !== "all") {
    const wantDisabled = String(status).toLowerCase() === "disabled";
    list = list.filter((r) => r.disabled === wantDisabled);
  }

  // keyword
  const needle = String(q || "").trim().toLowerCase();
  if (needle) {
    list = list.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.email.toLowerCase().includes(needle) ||
        r.phone.toLowerCase().includes(needle) ||
        String(r.id).toLowerCase().includes(needle)
    );
  }
  return list;
}

function paginate(arr, page = 1, limit = 10) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const n = Math.max(1, parseInt(limit, 10) || 10);
  const start = (p - 1) * n;
  return { slice: arr.slice(start, start + n), total: arr.length, page: p, limit: n };
}

/* ------------------------------ GET --------------------------------
   GET /api/admin/users?role=all|guest|host|partner|admin
                         &status=all|enabled|disabled
                         &q=&page=&limit=
--------------------------------------------------------------------- */
router.get("/users", async (req, res) => {
  try {
    const { role = "all", status = "all", q = "", page = 1, limit = 10 } =
      req.query;

    // 1) Pull all auth users (up to 1000 per page).
    let users = [];
    let nextToken;
    do {
      const page = await auth.listUsers(1000, nextToken);
      users = users.concat(page.users);
      nextToken = page.pageToken;
    } while (nextToken);

    // 2) Batch-get matching Firestore profiles
    //    (docs keyed by uid under 'users/{uid}')
    const chunks = [];
    for (let i = 0; i < users.length; i += 10) chunks.push(users.slice(i, i + 10));

    const profiles = {};
    await Promise.all(
      chunks.map(async (subset) => {
        const refs = subset.map((u) => db.collection("users").doc(u.uid));
        const snaps = await db.getAll(...refs);
        snaps.forEach((snap) => (profiles[snap.id] = snap.exists ? snap.data() : {}));
      })
    );

    // 3) Merge + normalize rows
    const rows = users.map((u) => toRow(u, profiles[u.uid]));

    // 4) Filter + counts + pagination
    const filtered = applyFilters(rows, { role, status, q });
    const counts = {
      total: rows.length,
      admins: rows.filter((r) => r.role === "admin").length,
      disabled: rows.filter((r) => r.disabled).length,
    };
    const { slice, total, page: p, limit: n } = paginate(filtered, page, limit);

    res.json({ data: slice, total, page: p, limit: n, counts });
  } catch (e) {
    console.error("GET /admin/users error:", e);
    res.status(500).json({ message: "Failed to load users" });
  }
});

/* ----------------------------- PATCH --------------------------------
   PATCH /api/admin/users/:id  { role?, disabled? }
   - You CANNOT set role=admin here.
   - If the current role is admin, the user is immutable via this API.
--------------------------------------------------------------------- */
router.patch("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let { role, disabled } = req.body ?? {};

    // Load auth + profile
    const user = await auth.getUser(id).catch(() => null);
    if (!user) return res.status(404).json({ message: "User not found" });

    const profileRef = db.collection("users").doc(id);
    const profileSnap = await profileRef.get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    const currentRole =
      (profile?.role || user.customClaims?.role || "guest").toLowerCase();

    // Hard lock: admins are *not* editable here
    if (currentRole === "admin")
      return res
        .status(403)
        .json({ message: "Admin is locked. Update only on the secure backend." });

    // Validate role (if provided)
    if (typeof role !== "undefined") {
      role = String(role).toLowerCase();
      const allowed = ["guest", "host", "partner"];
      if (!allowed.includes(role)) {
        return res
          .status(400)
          .json({ message: "Invalid role. Allowed: guest | host | partner" });
      }
    }

    // Apply updates
    const updates = {};
    if (typeof role !== "undefined") updates.role = role;

    // Firestore profile first (idempotent)
    if (Object.keys(updates).length) await profileRef.set(updates, { merge: true });

    // Auth disabled toggle (if provided)
    if (typeof disabled !== "undefined") {
      await auth.updateUser(id, { disabled: !!disabled });
    }

    // Return fresh merged row
    const freshUser = await auth.getUser(id);
    const freshProf = (await profileRef.get()).data() || {};
    res.json({ ok: true, data: toRow(freshUser, freshProf) });
  } catch (e) {
    console.error("PATCH /admin/users/:id error:", e);
    res.status(500).json({ message: "Failed to update user" });
  }
});

export default router;
