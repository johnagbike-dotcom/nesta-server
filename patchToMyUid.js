// patchToMyUid.js (ESM)
// Reassign seeded booking + thread from demo guest to YOUR real auth uid

import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Admin init (service account) ---
const sa = JSON.parse(fs.readFileSync(path.join(__dirname, "serviceAccountKey.json"), "utf8"));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// --- CONFIG: change this to your real signed-in uid ---
const MY_UID = "ukree4MCt0XLONHNeURCP5wnpPm2";

// These are the demo values used by seed scripts
const DEMO_GUEST = "demo_guest_uid_456";
const DEMO_HOST  = "demo_host_uid_123";

// Update all bookings owned by the demo guest -> to your uid
async function moveBookings() {
  const snap = await db.collection("bookings").where("userId", "==", DEMO_GUEST).get();
  if (snap.empty) {
    console.log("No demo bookings to move.");
    return;
  }
  const batch = db.batch();
  snap.forEach(doc => {
    batch.update(doc.ref, {
      userId: MY_UID,
      email: admin.firestore.FieldValue.delete(), // optional: remove demo email
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  console.log(`✅ Moved ${snap.size} booking(s) to your uid.`);
}

// Recreate threads so the participant is you instead of the demo uid.
// We’ll copy data & messages into a new threadId that uses your uid.
async function moveThreads() {
  const threadsSnap = await db
    .collection("threads")
    .where("participants", "array-contains", DEMO_GUEST)
    .get();

  if (threadsSnap.empty) {
    console.log("No demo threads to move.");
    return;
  }

  for (const tDoc of threadsSnap.docs) {
    const t = tDoc.data();
    const listingId = t.listingId || "listing";
    const other = t.participants.find((p) => p !== DEMO_GUEST) || DEMO_HOST;

    // Build the NEW thread id the same way the app does (sorted)
    const newId = [MY_UID, other, listingId].sort().join("_");
    const newRef = db.collection("threads").doc(newId);

    // Create/merge the new thread
    await newRef.set(
      {
        participants: [MY_UID, other],
        participantsKey: [MY_UID, other].sort().join("_"),
        listingId,
        listingTitle: t.listingTitle || "",
        createdAt: t.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        lastMessageAt: t.lastMessageAt || FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Copy messages
    const msgs = await tDoc.ref.collection("messages").orderBy("sentAt").get();
    const batch = db.batch();
    msgs.forEach((m) => {
      const d = m.data();
      const newMsgRef = newRef.collection("messages").doc(m.id);
      batch.set(newMsgRef, d);
    });
    await batch.commit();

    console.log(`✅ Copied ${msgs.size} message(s) to thread ${newId}`);

    // (Optional) delete old demo thread
    // await tDoc.ref.delete();
  }
}

(async function run() {
  console.log("— Reassigning demo data to your uid —");
  await moveBookings();
  await moveThreads();
  console.log("🎯 Done. Open the app and refresh Chat/Bookings.");
  process.exit(0);
})().catch((e) => {
  console.error("❌ Patch error:", e);
  process.exit(1);
});