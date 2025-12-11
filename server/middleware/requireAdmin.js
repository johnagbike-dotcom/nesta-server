// server/middleware/requireAdmin.js  (ESM)
import { adminAuth, db } from '../firebaseAdmin.js';

export default async function requireAdmin(req, res, next) {
  try {
    // Accept Firebase ID token via Authorization: Bearer <token>
    const authz = req.headers.authorization || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });

    const decoded = await adminAuth.verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email || null };

    // users/{uid}.role === 'admin'  OR users/{uid}.isAdmin === true
    const userDoc = await db.collection('users').doc(decoded.uid).get();
    const u = userDoc.exists ? userDoc.data() : {};
    const isAdmin = u?.role === 'admin' || u?.isAdmin === true;

    if (!isAdmin) return res.status(403).json({ ok: false, error: 'Admin only' });
    next();
  } catch (err) {
    console.error('requireAdmin', err.message);
    res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
} 
