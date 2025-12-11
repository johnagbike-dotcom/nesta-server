// routes/webhooks.js
import express from "express";
import crypto from "crypto";
import admin from "firebase-admin";

// --- Firebase Admin (init once) ---
try {
  admin.app();
} catch (_) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const router = express.Router();

/* -------------------------------------------------------
* Helpers
* ----------------------------------------------------- */

// Update booking by reference (shared by both providers)
async function markBookingByReference(reference, fields = {}) {
  if (!reference) return false;

  const snap = await db
    .collection("bookings")
    .where("reference", "==", reference)
    .limit(1)
    .get();

  if (snap.empty) return false;

  const docRef = snap.docs[0].ref;
  await docRef.set(
    {
      ...fields,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return true;
}

/* -------------------------------------------------------
* Paystack webhook
* - Header: x-paystack-signature (HMAC-SHA512 of raw body with secret)
* ----------------------------------------------------- */
router.post(
  "/paystack",
  // IMPORTANT: need raw body for signature verification
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const secret = process.env.PAYSTACK_SECRET_KEY;
      const signature = req.headers["x-paystack-signature"];

      if (!secret || !signature) {
        return res.status(400).send("Missing secret/signature");
      }

      // Compute HMAC of the RAW request body
      const computed = crypto
        .createHmac("sha512", secret)
        .update(req.body) // raw Buffer
        .digest("hex");

      if (computed !== signature) {
        return res.status(401).send("Invalid signature");
      }

      // Now it’s safe to parse the JSON
      const event = JSON.parse(req.body.toString());

      // Typical successful event is "charge.success"
      if (event?.event === "charge.success") {
        const data = event.data || {};
        const reference = data.reference || null;

        const ok = await markBookingByReference(reference, {
          status: "confirmed",
          gateway: "success",
          provider: "paystack",
          // Keep the raw payload for audits if you want:
          // raw: event,
        });

        if (!ok) {
          // No booking found, still 200 so Paystack does not retry forever
          return res.status(200).send("No matching booking");
        }
      }

      return res.status(200).send("OK");
    } catch (err) {
      console.error("Paystack webhook error:", err);
      // Return 200 so provider doesn't hammer retries while you debug
      return res.status(200).send("Handled");
    }
  }
);

/* -------------------------------------------------------
* Flutterwave webhook
* - Header: verif-hash must match FLW_WEBHOOKS_HASH
* ----------------------------------------------------- */
router.post(
  "/flutterwave",
  // raw not strictly required for FLW, but harmless and consistent
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const flwHash = process.env.FLW_WEBHOOKS_HASH;
      const headerHash = req.headers["verif-hash"];

      if (!flwHash || headerHash !== flwHash) {
        return res.status(401).send("Invalid hash");
      }

      const payload = JSON.parse(req.body.toString());
      const evt = payload?.event;
      const data = payload?.data || {};

      // For card/ussd/etc. payments you'll usually see:
      // event: "charge.completed" with data.status === "successful"
      const successful =
        (evt === "charge.completed" || evt === "transfer.completed") &&
        (data.status === "successful" || data.status === "completed");

      if (successful) {
        const reference =
          data?.tx_ref || data?.flw_ref || data?.reference || null;

        const ok = await markBookingByReference(reference, {
          status: "confirmed",
          gateway: "success",
          provider: "flutterwave",
        });

        if (!ok) {
          return res.status(200).send("No matching booking");
        }
      }

      return res.status(200).send("OK");
    } catch (err) {
      console.error("Flutterwave webhook error:", err);
      return res.status(200).send("Handled");
    }
  }
);

export default router; 