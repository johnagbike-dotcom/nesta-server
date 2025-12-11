// nesta-server/firebaseAdmin.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";

// Resolve local directory safely
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");

// Check key file exists
if (!fs.existsSync(serviceAccountPath)) {
  console.error("[firebaseAdmin] ❌ serviceAccountKey.json NOT FOUND:", serviceAccountPath);
}

let serviceAccount = null;
try {
  serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
  console.log("[firebaseAdmin] 🔑 Loaded serviceAccountKey.json");
} catch (err) {
  console.error("[firebaseAdmin] Failed to read serviceAccountKey.json:", err.message);
}

// -------------------------------------------
// Prevent Firebase Admin from re-initializing
// -------------------------------------------

let adminApp = null;

if (admin.apps.length === 0) {
  // First initialization
  try {
    adminApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("[firebaseAdmin] ✅ Firebase Admin initialized");
  } catch (e) {
    console.error("[firebaseAdmin] ❌ Failed to init Admin SDK:", e.message);
  }
} else {
  // Reuse existing initialized app
  adminApp = admin.app();
  console.log("[firebaseAdmin] ♻ Reusing existing Firebase Admin instance");
}

let adminDb = null;
try {
  adminDb = admin.firestore();
  console.log("[firebaseAdmin] 📦 Firestore Admin DB ready");
} catch (e) {
  console.error("[firebaseAdmin] ❌ Failed getting Firestore DB:", e.message);
}

// Export both ways
export { adminApp, adminDb };
export default adminDb;
