// server/payments/paystack.js
import axios from "axios";
import express from "express";
import { db } from "../utils/db.js"; // your Firestore helper
import { Timestamp } from "firebase-admin/firestore";

const router = express.Router();

// Use ONE canonical env var name, but allow legacy fallback if set
const PAYSTACK_SECRET =
  process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET || "";

// Your live frontend domain (for redirect after payment)
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const isLive = Boolean(PAYSTACK_SECRET);

/**
 * POST /payments/paystack/initialize
 *
 * Body: { email, listingId, nights? }
 *
 * - Server loads the listing and computes amountN
 * - Creates a pending booking in Firestore
 * - Calls Paystack initialize with metadata including bookingId
 * - Returns authorization_url + reference + bookingId to the client
 */
router.post("/initialize", async (req, res) => {
  try {
    const { email, listingId, nights: nightsRaw = 1, title: clientTitle } =
      req.body || {};

    if (!email || !listingId) {
      return res.status(400).json({ error: "email and listingId are required" });
    }

    // 1) Load listing from Firestore so the client cannot cheat amount
    const snap = await db.collection("listings").doc(listingId).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const listing = snap.data() || {};
    const nightly = Number(listing.pricePerNight || listing.price || 0);
    const nights = Math.max(1, Number(nightsRaw) || 1);
    const amountN = nightly * nights;

    if (!amountN || amountN <= 0) {
      return res
        .status(400)
        .json({ error: "Listing has no valid pricePerNight/price" });
    }

    const bookingTitle =
      clientTitle || listing.title || listing.name || "Nesta stay";

    // 2) Pre-create pending booking
    const bookingRef = db.collection("bookings").doc();
    const bookingId = bookingRef.id;

    const baseBooking = {
      id: bookingId,
      listingId,
      title: bookingTitle,
      email,
      nights,
      amountN,
      provider: "paystack",
      reference: null,
      status: "pending",
      gateway: isLive ? "init" : "mock",
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };

    await bookingRef.set(baseBooking);

    // 3) If not live, keep your mock flow
    if (!isLive) {
      return res.status(200).json({
        mode: "mock",
        bookingId,
        message:
          "PAYSTACK_SECRET_KEY not set; created mock pending booking only.",
      });
    }

    // 4) Real Paystack initialize
    const kobo = Math.round(amountN * 100);

    const initResp = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: kobo,
        callback_url: `${FRONTEND_URL}/bookings`, // guest returns here
        metadata: {
          bookingId,
          listingId,
          title: bookingTitle,
          amountN,
          nights,
        },
      },
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
        timeout: 15000,
      }
    );

    const data = initResp.data;
    if (!data?.status || !data?.data?.authorization_url) {
      return res
        .status(502)
        .json({ error: "Paystack init failed", detail: data });
    }

    const ref = data.data.reference;
    const authUrl = data.data.authorization_url;

    // 5) Attach reference to our booking
    await bookingRef.set(
      {
        reference: ref,
        gateway: "paystack",
        updatedAt: Timestamp.now(),
      },
      { merge: true }
    );

    return res.status(200).json({
      mode: "paystack",
      authorization_url: authUrl,
      reference: ref,
      bookingId,
    });
  } catch (err) {
    console.error("Paystack init error:", err?.response?.data || err.message);
    return res.status(500).json({
      error: "init error",
      detail: err?.response?.data || err.message,
    });
  }
});

/**
 * POST /payments/paystack/verify
 *
 * Optional manual verification if you ever call it from the client.
 * Body: { reference, bookingId }
 */
router.post("/verify", async (req, res) => {
  try {
    const { reference, bookingId } = req.body || {};
    if (!bookingId) {
      return res.status(400).json({ error: "bookingId required" });
    }

    let gateway = "unknown";
    let status = "pending";

    if (isLive && reference) {
      const v = await axios.get(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(
          reference
        )}`,
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
          timeout: 15000,
        }
      );

      const ok = v.data?.status && v.data?.data?.status === "success";
      gateway = ok ? "success" : v.data?.data?.status || "failed";
      status = ok ? "confirmed" : "cancelled";
    } else if (!isLive) {
      // mock success when not live
      gateway = "success";
      status = "confirmed";
    }

    await db
      .collection("bookings")
      .doc(bookingId)
      .set(
        { gateway, status, updatedAt: Timestamp.now() },
        { merge: true }
      );

    return res.status(200).json({ ok: true, bookingId, status, gateway });
  } catch (err) {
    console.error("Paystack verify error:", err?.response?.data || err.message);
    return res.status(500).json({
      error: "verify error",
      detail: err?.response?.data || err.message,
    });
  }
});

export default router;
