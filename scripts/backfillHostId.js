// node scripts/backfillHostId.js
import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/** Init admin via GOOGLE_APPLICATION_CREDENTIALS (.env points to serviceAccountKey.json) */
if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();

async function backfill() {
  const bookingsSnap = await db.collection("bookings").get();
  let fixed = 0, skipped = 0;

  for (const docSnap of bookingsSnap.docs) {
    const b = docSnap.data();
    if (b.hostId) { skipped++; continue; }
    if (!b.listingId) { skipped++; continue; }

    const listingSnap = await db.collection("listings").doc(b.listingId).get();
    const ownerId = listingSnap.exists ? listingSnap.data().ownerId : null;
    if (ownerId) {
      await docSnap.ref.update({ hostId: ownerId });
      fixed++;
      console.log(`✅ fixed ${docSnap.id} -> hostId=${ownerId}`);
    } else {
      console.log(`⚠️  cannot find ownerId for listing ${b.listingId} (booking ${docSnap.id})`);
    }
  }

  console.log(`Done. Fixed: ${fixed}, skipped: ${skipped}`);
}

backfill().catch(err => {
  console.error(err);
  process.exit(1);
}); 