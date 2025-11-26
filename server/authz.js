// server/authz.js (ESM)
export function requireAuth(req, res, next) {
  // Minimal mock: read user from a header or cookie you already use.
  // Replace with your real auth later (Firebase Auth / JWT).
  const uid = req.get("x-user-id") || "guest";
  const role = req.get("x-user-role") || "guest";
  req.user = { uid, role };
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
} 
