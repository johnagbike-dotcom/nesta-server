// seedListings.js (ESM)
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase credentials
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function seedListings() {
  const listingsRef = db.collection('listings');

  const listings = [
    {
      title: 'Bungalow in Port Harcourt',
      location: 'Port Harcourt, Nigeria',
      pricePerNight: 42000,
      hostId: 'demo_host_uid_123',
      hostEmail: 'johnagbike@yahoo.com',
      images: [
        'https://source.unsplash.com/featured/?bungalow,portharcourt',
      ],
      description: 'A cozy bungalow for short stays, perfect for guests visiting Port Harcourt.',
      available: true,
      rating: 4.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      title: 'Luxury Apartment in Lagos',
      location: 'Lekki, Lagos',
      pricePerNight: 65000,
      hostId: 'demo_host_uid_123',
      hostEmail: 'johnagbike@yahoo.com',
      images: [
        'https://source.unsplash.com/featured/?apartment,lagos',
      ],
      description: 'A luxury apartment in the heart of Lekki — ideal for business and leisure.',
      available: true,
      rating: 4.9,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  for (const listing of listings) {
    const docRef = listingsRef.doc();
    await docRef.set(listing);
    console.log(`✅ Created listing: ${listing.title}`);
  }

  console.log('🎯 Done seeding listings.');
  process.exit(0);
}

seedListings().catch((error) => {
  console.error('❌ Error seeding listings:', error);
  process.exit(1);
}); 