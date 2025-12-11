// nesta-server/seedAdmin.js  (ESM)

import admin from "firebase-admin";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve folder for this file (because we're using ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load service account JSON that sits next to this file
const serviceAccount = JSON.parse(
  readFileSync(path.join(__dirname, "serviceAccountKey.json"), "utf8")
);

// Initialise Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

/**
 *  🔴 IMPORTANT:
 *  - Go to Firebase Console → Authentication → Users
 *  - Copy the **User UID** for `johnagbike@yahoo.com`
 *  - Paste it below as ADMIN_UID
 */
const ADMIN_UID = "ukree4MCt0XLONHNeURCP5wnpPm2"; // <-- replace this
const ADMIN_EMAIL = "johnagbike@yahoo.com";

async function seedAdmin() {
  try {
    if (!ADMIN_UID || ADMIN_UID.startsWith("PUT_")) {
      throw new Error(
        "Please edit seedAdmin.js and replace ADMIN_UID with your real UID from Firebase Auth."
      );
    }

    // 1) Create / update Firestore user document
    await db.doc(`users/${ADMIN_UID}`).set(
      {
        email: ADMIN_EMAIL,
        name: "John Agbike",
        role: "admin",
        isAdmin: true,
        verified: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 2) Set custom admin claim for security rules
    await auth.setCustomUserClaims(ADMIN_UID, { admin: true });

    console.log("✅ Admin user seeded and admin claim set.");
  } catch (err) {
    console.error("❌ Error seeding admin:", err);
  } finally {
    process.exit();
  }
}

seedAdmin();
