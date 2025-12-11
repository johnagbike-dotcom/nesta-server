const express = require("express");
const router = express.Router();
const { db } = require("../firebase-admin");
const dayjs = require("dayjs");

// SETTINGS
const RELEASE_WINDOW_DAYS = 3; // change if needed

// GET /api/bookings/:id/contacts
router.get("/:id/contacts", async (req, res) => {
  try {
    const bookingId = req.params.id;
    const userEmail = req.user?.email; // assuming auth middleware sets req.user

    if (!bookingId) return res.status(400).json({ error: "Missing booking ID" });

    const snap = await db.collection("bookings").doc(bookingId).get();
    if (!snap.exists) return res.status(404).json({ error: "Booking not found" });

    const b = snap.data();
    const isGuest = b.email === userEmail;
    const isHost = b.hostEmail === userEmail || b.ownerEmail === userEmail;
    const isAdmin = req.user?.role === "admin";

    if (!isGuest && !isHost && !isAdmin)
      return res.status(403).json({ error: "Unauthorized" });

    if (b.status !== "confirmed")
      return res.status(403).json({ error: "Booking not confirmed yet" });

    // Host must have subscription active
    const hostSnap = await db.collection("users").doc(b.hostId).get();
    const host = hostSnap.exists ? hostSnap.data() : {};
    if (!host.subscriptionActive)
      return res.status(403).json({ error: "Host not subscribed" });

    // Check timing window
    const checkIn = b.checkIn?.toDate ? b.checkIn.toDate() : new Date(b.checkIn);
    const now = new Date();
    const releaseThreshold = dayjs(checkIn).subtract(RELEASE_WINDOW_DAYS, "day");

    if (dayjs(now).isBefore(releaseThreshold))
      return res.status(403).json({
        error: "CONTACT_NOT_AVAILABLE_YET",
        message: `Contact details will be available ${RELEASE_WINDOW_DAYS} days before check-in`,
      });

    // Reveal contact details
    if (!b.contactReleased) {
      await db.collection("bookings").doc(bookingId).update({
        contactReleased: true,
        contactReleasedAt: new Date(),
        refundPolicyStatus: "restricted",
      });
    }

    return res.json({
      email: host.email || null,
      phone: host.phone || null,
      whatsapp: host.whatsapp || null,
      released: true,
    });
  } catch (err) {
    console.error("contact endpoint error", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
