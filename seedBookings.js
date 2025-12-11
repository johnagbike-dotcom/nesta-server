// seedBookings.js (ESM) — creates a booking + a chat thread with one message
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Admin init (service account) ----
const saPath = path.join(__dirname, "serviceAccountKey.json");
const serviceAccount = JSON.parse(fs.readFileSync(saPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;

// ---- constants you can tweak for local dev ----
const HOST_UID = "demo_host_uid_123";
const GUEST_UID = "demo_guest_uid_456";
const GUEST_EMAIL = "guest@example.com";
const GUEST_NAME = "Anna (Guest)";

// util: make a deterministic thread id: host_guest_listing
const makeThreadId = (a, b, l) => [a, b, l].sort().join("_");

// date helpers
const today = new Date();
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

async function run() {
  console.log("— Seeding booking + chat —");

  // 1) pick any listing for the demo host
  const listSnap = await db
    .collection("listings")
    .where("hostId", "==", HOST_UID)
    .limit(1)
    .get();

  if (listSnap.empty) {
    console.error("No listings found for host:", HOST_UID);
    process.exit(1);
  }

  const listingDoc = listSnap.docs[0];
  const listing = { id: listingDoc.id, ...listingDoc.data() };

  // 2) create a booking
  const nights = 2;
  const checkInDate = addDays(today, 3);
  const checkOutDate = addDays(checkInDate, nights);
  const amountN = (Number(listing.pricePerNight || 0) || 0) * nights * 1; // 1 guest

  const booking = {
    listingId: listing.id,
    title: listing.title || "Listing",
    hostId: listing.hostId || HOST_UID,
    userId: GUEST_UID,
    email: GUEST_EMAIL,
    guests: 1,
    nights,
    amountN,
    provider: "paystack",
    gateway: "success",
    reference: `PST_${Math.floor(Date.now() / 1000)}`,
    status: "confirmed", // <- important so it shows in Your Bookings
    checkIn: Timestamp.fromDate(checkInDate),
    checkOut: Timestamp.fromDate(checkOutDate),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const bookingRef = db.collection("bookings").doc();
  await bookingRef.set(booking);
  console.log(`✅ Created booking for listing: ${listing.title} → ${bookingRef.id}`);

  // 3) create a thread for this host/guest/listing
  const threadId = makeThreadId(HOST_UID, GUEST_UID, listing.id);
  const threadRef = db.collection("threads").doc(threadId);

  await threadRef.set(
    {
      participants: [HOST_UID, GUEST_UID],
      participantsKey: [HOST_UID, GUEST_UID].sort().join("_"),
      listingId: listing.id,
      listingTitle: listing.title || "Listing",
      lastMessageAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log(`✅ Upserted thread: ${threadId}`);

  // 4) insert a first message (so the UI has something to render)
  const msgRef = threadRef.collection("messages").doc();
  await msgRef.set({
    text: "Hello! Thanks for your interest — feel free to ask any questions.",
    senderId: HOST_UID,
    senderRole: "host",
    sentAt: FieldValue.serverTimestamp(),
    status: "sent",
  });
  await threadRef.update({ lastMessageAt: FieldValue.serverTimestamp() });
  console.log("✅ Added starter message");

  console.log("🎯 Done seeding booking + chat.");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Seed error:", err);
  process.exit(1);
}); 
