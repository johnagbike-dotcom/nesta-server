// nesta-server/routes/bookings.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();

// ---------- file helpers ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");

function ensureFile(file, seed) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(seed ?? { bookings: [] }, null, 2), "utf8");
  }
}
function readJSON(file, seed) {
  ensureFile(file, seed);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return seed ?? { bookings: [] }; }
}
function writeJSON(file, data) {
  ensureFile(file, data);
  fs.writeFileSync(file, JSON.stringify(data ?? { bookings: [] }, null, 2), "utf8");
}

// ---------- GET /api/bookings ----------
router.get("/", (_req, res) => {
  const db = readJSON(BOOKINGS_FILE, { bookings: [] });
  res.json(db.bookings || []); // UI accepts array
});

// ---------- PATCH /api/bookings/:id/status ----------
router.patch("/:id/status", (req, res) => {
  const { id } = req.params;
  const next = String(req.body?.status || "").toLowerCase();
  if (!["pending", "confirmed", "cancelled", "refunded"].includes(next)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  const db = readJSON(BOOKINGS_FILE, { bookings: [] });
  const idx = (db.bookings || []).findIndex(b =>
    String(b.id || b._id || b.reference || b.ref || b.bookingId) === String(id)
  );
  if (idx === -1) return res.status(404).json({ message: "Booking not found" });

  db.bookings[idx].status = next;
  db.bookings[idx].updatedAt = new Date().toISOString();
  writeJSON(BOOKINGS_FILE, db);

  res.json({ ok: true, booking: db.bookings[idx] });
});

// ---------- optional POST shorthands ----------
["confirmed", "cancelled", "refunded"].forEach(s => {
  router.post(`/:id/${s}`, (req, res, next) => {
    req.method = "PATCH";
    req.url = `/${req.params.id}/status`;
    req.body = { status: s };
    next();
  });
});

export default router;
