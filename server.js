// server.js (ESM) — NestaNaija API (Production Ready)

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import crypto from "crypto";

// Routers
import webhooksRouter from "./routes/webhooks.js";
import adminRoutes from "./routes/adminRoutes.js";
import usersRouter from "./routes/users.js";
import hostRoutes from "./routes/hostRoutes.js";
import listingsRouter from "./routes/listings.js";
import bookingsRouter from "./routes/bookings.js";
import kycRoutes from "./routes/kycRoutes.js";
import onboardingRoutes from "./routes/onboardingRoutes.js";

// Firebase Admin
import admin from "firebase-admin";
try {
  admin.app();
} catch {
  admin.initializeApp();
}
const db = admin.firestore();

// ----------------------------------------------------------------------------
// App
// ----------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);

// ----------------------------------------------------------------------------
// CORS — Production Grade (NO hardcoded localhost responses)
// ----------------------------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  // Local dev
  "http://localhost:3000",
  "https://localhost:3000",

  // Render (fallback)
  "https://nesta-client.onrender.com",

  // Production (Luxury Brand)
  "https://nestanaija.com",
  "https://www.nestanaija.com",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, Content-Type, Accept, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ----------------------------------------------------------------------------
// Webhooks (RAW body — MUST come before express.json)
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Normal middleware
// ----------------------------------------------------------------------------
app.use(express.json());
app.use(morgan("dev"));

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
app.use("/api", listingsRouter);

app.use("/api/admin", usersRouter);
app.use("/api/admin", adminRoutes);
app.use("/api/host", hostRoutes);

app.use("/api/webhooks", webhooksRouter);

app.use("/api", kycRoutes);
app.use("/api", onboardingRoutes);

app.use("/api/bookings", bookingsRouter);
app.use("/api/transactions", bookingsRouter);

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// API 404
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ----------------------------------------------------------------------------
// Static (safe to keep)
// ----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ----------------------------------------------------------------------------
// Paystack Webhook
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
  const meta = data.metadata || {};

  const bookingId = meta.bookingId || meta.booking_id || null;
  const amountN = Math.round(Number(data.amount || 0) / 100);

  try {
    const ref = bookingId
      ? db.collection("bookings").doc(bookingId)
      : db.collection("bookings").doc();

    await ref.set(
      {
        id: ref.id,
        provider: "paystack",
        gateway: "success",
        status: "confirmed",
        reference: data.reference,
        amountN,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).send("ok");
  } catch (e) {
    console.error("Paystack webhook error:", e);
    return res.status(500).send("Webhook handling failed");
  }
}

// ----------------------------------------------------------------------------
// Flutterwave Webhook
// ----------------------------------------------------------------------------
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

  const data = payload?.data || {};
  if (String(data?.status).toLowerCase() !== "successful")
    return res.status(200).send("Ignored");

  try {
    const ref = db.collection("bookings").doc(
      data?.meta?.bookingId || undefined
    );

    await ref.set(
      {
        provider: "flutterwave",
        gateway: "success",
        status: "confirmed",
        reference: data.id?.toString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

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
  console.log(`NestaNaija API running on port ${PORT}`);
});
