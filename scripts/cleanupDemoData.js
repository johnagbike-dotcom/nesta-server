// nesta-server/scripts/cleanupDemoData.js
import { adminDb } from "../firebaseAdmin.js";

async function deleteQueryBatch(colName, query) {
  const snap = await query.get();
  if (snap.empty) {
    console.log(`[${colName}] No more matching docs.`);
    return;
  }

  const batch = adminDb.batch();
  snap.docs.forEach((doc) => {
    console.log(`[${colName}] Deleting`, doc.id, doc.data().email || doc.data().guestEmail);
    batch.delete(doc.ref);
  });
  await batch.commit();
}

// TUNE THESE SAFELY – only demo emails!
const demoGuestEmails = [
  "guest@example.com",
  "guest+15711@example.com",
];
const demoHostEmails = [
  "host@nesta.dev",
];

async function run() {
  console.log("Starting cleanup…");

  // BOOKINGS: demo guests
  for (const email of demoGuestEmails) {
    const q = adminDb.collection("bookings").where("email", "==", email);
    await deleteQueryBatch("bookings", q);
    const q2 = adminDb.collection("bookings").where("guestEmail", "==", email);
    await deleteQueryBatch("bookings", q2);
  }

  // BOOKINGS: demo hosts
  for (const email of demoHostEmails) {
    const q = adminDb.collection("bookings").where("hostEmail", "==", email);
    await deleteQueryBatch("bookings", q);
  }

  // LISTINGS: demo hosts
  for (const email of demoHostEmails) {
    const q = adminDb.collection("listings").where("hostEmail", "==", email);
    await deleteQueryBatch("listings", q);
    const q2 = adminDb.collection("listings").where("ownerEmail", "==", email);
    await deleteQueryBatch("listings", q2);
  }

  console.log("Cleanup done.");
}

run().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
