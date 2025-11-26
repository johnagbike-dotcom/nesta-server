// nesta-server/server/firebaseAdmin.js
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";

// Load service account JSON safely without "assert { type: 'json' }"
const serviceAccount = JSON.parse(
  fs.readFileSync(new URL("../serviceAccountKey.json", import.meta.url), "utf8")
);

// Initialize once (avoid "already exists" during dev restarts)
try {
  initializeApp({ credential: cert(serviceAccount) });
} catch {
  // no-op
}

export const adminDb = getFirestore(); 
