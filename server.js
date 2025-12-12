// server.js (ESM) — Nesta API + Paystack/Flutterwave webhooks

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

// ---- Firebase Admin (server SDK)
import admin from "firebase-admin";
try {
  admin.app();
} catch {
  // Uses GOOGLE_APPLICATION_CREDENTIALS / ADC (Render supports this)
  admin.initializeApp();
}
const db = admin.firestore();

// ----------------------------------------------------------------------------
// App
// ----------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);

// ----------------------------------------------------------------------------
// CORS (manual, production-ready)
// ----------------------------------------------------------------------------

// Add ALL allowed frontends here
// NOTE: Do NOT include trailing slashes.
const allowedOrigins = new Set([
  // Local dev
  "http://localhost:3000",
  "https://localhost:3000",

  // Render frontend
  "https://nesta-client.onrender.com",

  // Custom domains (frontend)
  "https://nestanaija.com",
  "https://www.nestanaija.com",
]);

// Optional: allow preview/staging domains via env (comma-separated)
if (process.env.ALLOWED_ORIGINS) {
  for (const o of process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)) {
    allowedOrigins.add(o);
  }
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Allow non-browser requests (no Origin header), e.g. Render health checks, curl, webhooks
  if (!origin) return next();

  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      // include Paystack/Flutterwave + Auth headers
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Paystack-Signature, verif-hash"
    );
  } else {
    // If you prefer to hard-block unknown origins with a clear message:
    // return res.status(403).json({ error: "CORS not allowed", origin });
    // But we allow it to pass for server-to-server calls that don't need CORS.
  }

  if (req.method === "OPTIONS") {
    // CORS preflight
    return res.sendStatus(204);
  }

  next();
});

// ----------------------------------------------------------------------------
// IMPORTANT: Webhooks need raw body for signature verification.
// Attach raw-body parsers BEFORE global express.json().
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

// Normal JSON body parser for the rest of the API:
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

// ----------------------------------------------------------------------------
// Routes under /api
// ----------------------------------------------------------------------------

// Prevent accidental shadowing / confusion: list these clearly

// Public / listings
app.use("/api", listingsRouter);

// KYC & onboarding
app.use("/api", kycRoutes);
app.use("/api", onboardingRoutes);

// Admin / users
app.use("/api/admin", usersRouter);
app.use("/api/admin", adminRoutes);

// Host
app.use("/api/host", hostRoutes);

// Bookings + transactions
app.use("/api/bookings", bookingsRouter);
app.use("/api/transactions", bookingsRouter); // alias used by some UIs

// Webhooks namespace (extra webhooks if any)
app.use("/api/webhooks", webhooksRouter);

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Root (optional) - helps confirm api domain is live
app.get("/", (_req, res) => res.status(200).send("Nesta API is running."));

// 404 (API)
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Static (optional)
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
  console.log(`nesta-server listening on port ${PORT}`);
});
