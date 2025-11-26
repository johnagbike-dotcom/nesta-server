// routes/kycRoutes.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
const KYC_FILE = path.join(DATA_DIR, "kyc.json");

// tiny file helpers
function ensureFile(file, seed) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(seed ?? {}, null, 2), "utf8");
}
function readJSON(file, seed) {
  ensureFile(file, seed);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return seed ?? {}; }
}
function writeJSON(file, data) {
  ensureFile(file, data ?? {});
  fs.writeFileSync(file, JSON.stringify(data ?? {}, null, 2), "utf8");
}

// GET /api/kyc/mine?userId=xxx
router.get("/kyc/mine", (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    if (!userId) return res.status(400).json({ error: "missing_userId" });
    const db = readJSON(KYC_FILE, { requests: [] });
    const rows = (db.requests || []).filter(r => String(r.userId) === userId);
    // Return latest if any
    rows.sort((a,b) =>
      new Date(b.submittedAt || b.createdAt || 0) - new Date(a.submittedAt || a.createdAt || 0)
    );
    return res.json({ latest: rows[0] || null, history: rows });
  } catch (e) {
    console.error("GET /kyc/mine failed:", e);
    res.status(500).json({ error: "kyc_mine_failed" });
  }
});

// POST /api/kyc/submit
// Body: { userId, name, email, phoneNumber, govIdType, govIdNumber, docUrl, address }
router.post("/kyc/submit", (req, res) => {
  try {
    const { userId, name, email, phoneNumber, govIdType, govIdNumber, docUrl, address } = req.body || {};
    if (!userId || !email || !name) {
      return res.status(400).json({ error: "missing_fields", need: ["userId","name","email"] });
    }
    const db = readJSON(KYC_FILE, { requests: [] });
    const now = new Date().toISOString();
    const id = `kyc_${Date.now()}_${Math.floor(Math.random()*1e5)}`;
    const row = {
      id,
      userId: String(userId),
      name: String(name),
      email: String(email),
      phoneNumber: phoneNumber ? String(phoneNumber) : "",
      govIdType: govIdType ? String(govIdType) : "",
      govIdNumber: govIdNumber ? String(govIdNumber) : "",
      docUrl: docUrl ? String(docUrl) : "",
      address: address ? String(address) : "",
      status: "pending",
      submittedAt: now,
      reviewedAt: "",
      history: [{ at: now, status: "pending", note: "Submitted" }],
    };
    db.requests = db.requests || [];
    db.requests.unshift(row);
    writeJSON(KYC_FILE, db);
    return res.json({ ok: true, data: row });
  } catch (e) {
    console.error("POST /kyc/submit failed:", e);
    res.status(500).json({ error: "kyc_submit_failed" });
  }
});

export default router;
