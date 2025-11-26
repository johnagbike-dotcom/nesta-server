// routes/authGuards.js
export function ensureAuth(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: "unauthorized" });
}

export function ensureKycApproved(req, res, next) {
  const status = req.user?.kycStatus || "none"; // none | pending | rejected | approved
  if (status === "approved") return next();
  return res.status(403).json({ error: "kyc_required", status });
}

export function ensureRole(role) {
  return (req, res, next) => {
    const r = String(req.user?.role || "guest").toLowerCase(); // guest|host|partner|admin
    if (r === role || r === "admin") return next();
    return res.status(403).json({ error: "insufficient_role", need: role, have: r });
  };
}
