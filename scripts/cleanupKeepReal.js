// nesta-server/scripts/cleanupKeepReal.js
import { adminDb } from "../firebaseAdmin.js";

const KEEP_EMAILS = [
  "john.agbike@gmail.com",   // guest
  "nesta.naija@gmail.com",   // partner
  "ashleigh.c.c@sky.com",    // host
].map((e) => e.toLowerCase());

function shouldKeepByEmail(data) {
  const guest =
    (data.email ||
      data.guestEmail ||
      data.guest ||
      "").toLowerCase();

  const host =
    (data.hostEmail ||
      data.ownerEmail ||
      data.listingOwner ||
      data.payeeEmail ||
      "").toLowerCase();

  // keep only if guest OR host/partner is in our whitelist
  return KEEP_EMAILS.includes(guest) || KEEP_EMAILS.includes(host);
}

async function cleanCollection(colName, emailBased = false) {
  console.log(`\n=== Cleaning ${colName} ===`);
  const snap = await adminDb.collection(colName).get();
  console.log(`[${colName}] total docs:`, snap.size);

  const batchSize = 400;
  let batch = adminDb.batch();
  let scanned = 0;
  let deleted = 0;
  let kept = 0;

  for (const doc of snap.docs) {
    scanned++;
    const data = doc.data() || {};

    let keep = false;
    if (emailBased) {
      keep = shouldKeepByEmail(data);
    }

    if (keep) {
      kept++;
      continue;
    }

    batch.delete(doc.ref);
    deleted++;

    if (deleted % batchSize === 0) {
      console.log(`[${colName}] committing batch after ${deleted} deletions…`);
      await batch.commit();
      batch = adminDb.batch();
    }
  }

  if (deleted % batchSize !== 0) {
    await batch.commit();
  }

  console.log(
    `[${colName}] scanned: ${scanned}, kept: ${kept}, deleted: ${deleted}`
  );
}

async function run() {
  console.log("KEEP_EMAILS =", KEEP_EMAILS);

  // Bookings collections (handle both capitalisations just in case)
  await cleanCollection("bookings", true);
  // If you also have "Bookings" with capital B, uncomment:
  // await cleanCollection("Bookings", true);

  // When you’re happy with bookings, uncomment these lines
  // to clean listings the same way:
  //
  await cleanCollection("listings", true);
  await cleanCollection("Listings", true);

  console.log("\nCleanup complete.");
}

run().catch((err) => {
  console.error("cleanupKeepReal failed:", err);
  process.exit(1);
});
