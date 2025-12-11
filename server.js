// server.js (ESM) — Nesta API + Paystack/Flutterwave webhooks
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";

import webhooksRouter from "./routes/webhooks.js";
import adminRoutes from "./routes/adminRoutes.js";
import usersRouter from "./routes/users.js";
import hostRoutes from "./routes/hostRoutes.js";
import listingsRouter from "./routes/listings.js";
import bookingsRouter from "./routes/bookings.js"; // includes /:id/contact
import kycRoutes from "./routes/kycRoutes.js";
import onboardingRoutes from "./routes/onboardingRoutes.js";

// ---- Firebase Admin (server SDK)
import admin from "firebase-admin";
try {
  admin.app();
} catch {
  // Uses GOOGLE_APPLICATION_CREDENTIALS / ADC
  admin.initializeApp();
}
const db = admin.firestore();

// ---- Node utils
import crypto from "crypto";

// ----------------------------------------------------------------------------
// App
// ----------------------------------------------------------------------------
const app = express();
// CORS
const allowedOrigins = [
  "http://localhost:3000",
  "https://nesta-client.onrender.com",
];

app.use(
  cors({
    origin(origin, callback) {
      // allow non-browser tools (Postman, curl – no origin header)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // optional: log unexpected origins for debugging
      console.warn("Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);


// IMPORTANT: Webhooks need raw body for signature verification.
// Attach raw-body parsers BEFORE global express.json():
app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  handlePaystackWebhook
);

app.post(
  "/api/flutterwave/webhook",
  express.raw({ type: "application/json" }),
  handleFlutterwaveWebhook
);

// Normal JSON body parser for the rest of the API:
app.use(express.json());
app.use(morgan("dev"));

// ----------------------------------------------------------------------------
// Routes under /api
// ----------------------------------------------------------------------------

// Listings & general
app.use("/api", listingsRouter);

// Admin / users / host
app.use("/api/admin", usersRouter);
app.use("/api/host", hostRoutes);
app.use("/api/admin", adminRoutes);

// Webhooks namespace (for any extra webhook routes you already had)
app.use("/api/webhooks", webhooksRouter);

// KYC & onboarding
app.use("/api", kycRoutes);
app.use("/api", onboardingRoutes);

// Bookings + transactions (admin dashboards, host reservations, guest views)
app.use("/api/bookings", bookingsRouter); // includes GET /:id, PATCH /:id/status, POST /:id/refund, GET /:id/contact
app.use("/api/transactions", bookingsRouter); // alias used by some UIs

// ❌ REMOVED: this was crashing in ESM and is no longer needed
// app.use("/api/bookings/contacts", require("./routes/bookingContacts"));

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// 404 (API)
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Static (optional; safe to leave)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ----------------------------------------------------------------------------
// Webhook Handlers
// ----------------------------------------------------------------------------
async function handlePaystackWebhook(req, res) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(500).send("PAYSTACK_SECRET_KEY missing");

  const signature = req.headers["x-paystack-signature"];
  const computed = crypto
    .createHmac("sha512", secret)
    .update(req.body)
    .digest("hex");

  if (computed !== signature) return res.status(401).send("Invalid signature");

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Bad JSON");
  }

  if (event?.event !== "charge.success") return res.status(200).send("Ignored");

  const data = event.data || {};
  const reference = data.reference;
  const meta = data.metadata || {};
  const bookingId = meta.bookingId || meta.booking_id || null;
  const listingId = meta.listingId || meta.listing_id || null;
  const email = data?.customer?.email || meta.email;
  const amountN = Math.round(Number(data.amount || 0) / 100); // kobo→Naira

  try {
    if (!bookingId) {
      const ref = db.collection("bookings").doc();
      await ref.set({
        id: ref.id,
        listingId: listingId || null,
        email: email || "guest@example.com",
        userId: meta.userId || null,
        title: meta.title || "",
        guests: Number(meta.guests || 1),
        nights: Number(meta.nights || 0),
        amountN,
        provider: "paystack",
        gateway: "success",
        status: "confirmed",
        reference,
        checkIn: meta.checkIn || null,
        checkOut: meta.checkOut || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      const ref = db.collection("bookings").doc(bookingId);
      await ref.set(
        {
          id: bookingId,
          provider: "paystack",
          gateway: "success",
          status: "confirmed",
          reference,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return res.status(200).send("ok");
  } catch (e) {
    console.error("Paystack webhook error:", e);
    return res.status(500).send("Webhook handling failed");
  }
}

async function handleFlutterwaveWebhook(req, res) {
  const expected = process.env.FLW_VERIF_HASH;
  if (!expected) return res.status(500).send("FLW_VERIF_HASH missing");

  const verifyHash = req.headers["verif-hash"];
  if (!verifyHash || verifyHash !== expected)
    return res.status(401).send("Invalid hash");

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Bad JSON");
  }

  const evt = payload?.event || payload?.event_type || "";
  const data = payload?.data || payload;
  if (!/charge\.completed/i.test(evt)) return res.status(200).send("Ignored");
  if (String(data?.status).toLowerCase() !== "successful")
    return res.status(200).send("Non-success");

  const txId = data?.id?.toString?.() || data?.tx_ref || data?.flw_ref || null;
  const meta = data?.meta || data?.meta_data || {};
  const bookingId = meta.bookingId || meta.booking_id || null;
  const listingId = meta.listingId || meta.listing_id || null;
  const email = data?.customer?.email || meta.email;
  const amountN = Math.round(Number(data?.amount || 0));

  try {
    if (!bookingId) {
      const ref = db.collection("bookings").doc();
      await ref.set({
        id: ref.id,
        listingId: listingId || null,
        email: email || "guest@example.com",
        userId: meta.userId || null,
        title: meta.title || "",
        guests: Number(meta.guests || 1),
        nights: Number(meta.nights || 0),
        amountN,
        provider: "flutterwave",
        gateway: "success",
        status: "confirmed",
        reference: txId,
        checkIn: meta.checkIn || null,
        checkOut: meta.checkOut || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      const ref = db.collection("bookings").doc(bookingId);
      await ref.set(
        {
          id: bookingId,
          provider: "flutterwave",
          gateway: "success",
          status: "confirmed",
          reference: txId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return res.status(200).send("ok");
  } catch (e) {
    console.error("Flutterwave webhook error:", e);
    return res.status(500).send("Webhook handling failed");
  }
}

// ----------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`nesta-server listening on http://localhost:${PORT}`);
});
