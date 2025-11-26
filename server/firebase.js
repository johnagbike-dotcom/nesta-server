// server/firebase.js (ESM)
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fs from 'node:fs';

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Prefer service account JSON if present; else use applicationDefault()
let app;
if (credPath && fs.existsSync(credPath)) {
  const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  app = initializeApp({ credential: cert(serviceAccount) });
} else {
  app = initializeApp({ credential: applicationDefault() });
}

export const db = getFirestore(app);
export { FieldValue }; 
