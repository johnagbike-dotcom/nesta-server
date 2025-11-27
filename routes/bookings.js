// nesta-server/routes/bookings.js
import { Router } from "express";
import admin from "firebase-admin";

const router = Router();
const db = admin.firestore();

/**
 * GET ALL BOOKINGS (ADMIN / HOST / PARTNER)
 */
router.get("/", async (req, res) => {
  try {
    const snapshot = await db.collection("bookings").get();
    const bookings = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    return res.json(bookings);
  } catch (err) {
    console.error("GET /bookings error:", err);
    return res.status(500).json({ message: "Failed to load bookings" });
  }
});

/**
 * UPDATE BOOKING STATUS
 */
router.patch("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body.status || "").toLowerCase();

    if (!["pending", "confirmed", "cancelled", "refunded"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const ref = db.collection("bookings").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ message: "Booking not found" });
    }

    await ref.update({
      status,
      updatedAt: new Date().toISOString(),
    });

    return res.json({ ok: true, id, status });
  } catch (err) {
    console.error("PATCH /bookings/:id/status error:", err);
    return res.status(500).json({ message: "Failed to update status" });
  }
});

/**
 * SHORTHAND ROUTES
 */
["confirmed", "cancelled", "refunded"].forEach(s => {
  router.post(`/:id/${s}`, (req, res, next) => {
    req.method = "PATCH";
    req.url = `/${req.params.id}/status`;
    req.body = { status: s };
    next();
  });
});

export default router;
