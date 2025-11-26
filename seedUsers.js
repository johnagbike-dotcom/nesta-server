// seedUsers.js (ESM version)
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load service account key
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function seedUsers() {
  const usersRef = db.collection('users');

  const users = [
    {
      uid: 'demo_host_uid_123',
      displayName: 'John (Host)',
      email: 'johnagbike@yahoo.com',
      role: 'host',
      partnerVerified: true,
      kycFiles: { reviewedAt: new Date().toISOString(), reviewer: 'system' },
      status: 'active',
      phoneNumber: '+2349012345678',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      uid: 'demo_guest_uid_456',
      displayName: 'Anna (Guest)',
      email: 'nesta.naija@gmail.com',
      role: 'guest',
      partnerVerified: false,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  for (const user of users) {
    await usersRef.doc(user.uid).set(user, { merge: true });
    console.log(`✅ Created or updated user: ${user.displayName} (${user.role})`);
  }

  console.log('🎯 Done seeding users.');
  process.exit(0);
}

seedUsers().catch((error) => {
  console.error('❌ Error seeding users:', error);
  process.exit(1);
}); 
