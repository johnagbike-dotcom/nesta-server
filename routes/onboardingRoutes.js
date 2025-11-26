// routes/onboardingRoutes.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");

const ONBOARD_FILE = path.join(DATA_DIR, "onboarding.json");
const KYC_FILE = path.join(DATA_DIR, "kyc.json"); // <- shared with admin if you like

function ensureFile(file, seed) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(seed ?? {}, null, 2), "utf8");
}
function readJSON(file, seed) {
  ensureFile(file, seed);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return seed ?? {};
  }
}
function writeJSON(file, data) {
  ensureFile(file, data ?? {});
  fs.writeFileSync(file, JSON.stringify(data ?? {}, null, 2), "utf8");
}

/* =========================
   KYC (public user endpoints)
   ========================= */

function validateKycPayload(p) {
  const err = {};
  // Mandatory BVN (11 digits)
  if (!p?.bvn || !/^\d{11}$/.test(String(p.bvn))) err.bvn = "Invalid BVN (11 digits required)";
  if (!p?.name) err.name = "name required";
  if (!p?.email) err.email = "email required";
  if (!p?.phoneNumber) err.phoneNumber = "phoneNumber required";
  if (!p?.address || String(p.address).length < 5) err.address = "address is too short";
  if (!p?.govIdType) err.govIdType = "govIdType required";
  if (!p?.govIdNumber) err.govIdNumber = "govIdNumber required";
  return err;
}

// GET /kyc/mine?userId=...
router.get("/kyc/mine", (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    if (!userId) return res.status(400).json({ error: "missing_userId" });

    const db = readJSON(KYC_FILE, { requests: [] });
    const list = db.requests || [];
    const mine = list.filter((r) => String(r.userId) === userId);
    // latest by submittedAt
    mine.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
    res.json({ latest: mine[0] || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "kyc_load_failed" });
  }
});

// POST /kyc/submit
router.post("/kyc/submit", (req, res) => {
  try {
    const p = req.body || {};
    const userId = String(p.userId || "");
    if (!userId) return res.status(400).json({ error: "missing_userId" });

    const fieldsErr = validateKycPayload(p);
    if (Object.keys(fieldsErr).length) {
      return res.status(400).json({ error: "invalid_kyc", fields: fieldsErr });
    }

    const now = new Date().toISOString();
    const db = readJSON(KYC_FILE, { requests: [] });
    db.requests = db.requests || [];

    const row = {
      id: `kyc_${Date.now()}_${Math.floor(Math.random() * 1e5)}`,
      userId,
      name: String(p.name || ""),
      email: String(p.email || ""),
      phoneNumber: String(p.phoneNumber || ""),
      address: String(p.address || ""),
      bvn: String(p.bvn || ""),
      govIdType: String(p.govIdType || ""),
      govIdNumber: String(p.govIdNumber || ""),
      docUrl: String(p.docUrl || ""),
      status: "pending", // pending | approved | rejected
      submittedAt: now,
      updatedAt: now,
    };

    // Upsert by user (always keep latest at front)
    db.requests.unshift(row);
    writeJSON(KYC_FILE, db);

    res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "kyc_submit_failed" });
  }
});

/* =========================
   Host / Partner onboarding
   ========================= */

function upsertApp(kind, payload) {
  const db = readJSON(ONBOARD_FILE, { host: [], partner: [] });
  const list = db[kind] || [];
  const i = list.findIndex((r) => String(r.userId) === String(payload.userId));
  const now = new Date().toISOString();
  const base = {
    id: `${kind}_${Date.now()}_${Math.floor(Math.random() * 1e5)}`,
    userId: String(payload.userId),
    email: String(payload.email || ""),
    portfolioUrl: String(payload.portfolioUrl || ""),
    note: String(payload.note || ""),
    status: "under_review", // under_review | approved | rejected
    submittedAt: now,
    updatedAt: now,
  };
  if (i === -1) list.unshift(base);
  else list[i] = { ...list[i], ...base, id: list[i].id, submittedAt: list[i].submittedAt, updatedAt: now };
  db[kind] = list;
  writeJSON(ONBOARD_FILE, db);
  return list.find((r) => String(r.userId) === String(payload.userId));
}
function getApp(kind, userId) {
  const db = readJSON(ONBOARD_FILE, { host: [], partner: [] });
  const list = db[kind] || [];
  return list.find((r) => String(r.userId) === String(userId)) || null;
}

// ---- Host ----
router.get("/onboarding/host/status", (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    if (!userId) return res.status(400).json({ error: "missing_userId" });
    return res.json({ data: getApp("host", userId) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "host_status_failed" });
  }
});
router.post("/onboarding/host/apply", (req, res) => {
  try {
    const { userId, email, portfolioUrl, note } = req.body || {};
    if (!userId) return res.status(400).json({ error: "missing_userId" });
    const row = upsertApp("host", { userId, email, portfolioUrl, note });
    return res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "host_apply_failed" });
  }
});

// ---- Partner ----
router.get("/onboarding/partner/status", (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    if (!userId) return res.status(400).json({ error: "missing_userId" });
    return res.json({ data: getApp("partner", userId) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "partner_status_failed" });
  }
});
router.post("/onboarding/partner/apply", (req, res) => {
  try {
    const { userId, email, portfolioUrl, note } = req.body || {};
    if (!userId) return res.status(400).json({ error: "missing_userId" });
    const row = upsertApp("partner", { userId, email, portfolioUrl, note });
    return res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "partner_apply_failed" });
  }
});

// --- ADMIN: list all applications ---
router.get("/onboarding/_all", (req, res) => {
  try {
    const kind = String(req.query.kind || "all").toLowerCase(); // host | partner | all
    const db = readJSON(ONBOARD_FILE, { host: [], partner: [] });
    let out = [];
    if (kind === "host" || kind === "partner") out = db[kind] || [];
    else out = [...(db.host || []), ...(db.partner || [])];
    out.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    res.json({ data: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "onboarding_list_failed" });
  }
});

// --- ADMIN: update application status (under_review | approved | rejected) ---
router.patch("/onboarding/:kind/:id/status", (req, res) => {
  try {
    const kind = String(req.params.kind || "");
    const id = String(req.params.id || "");
    const next = String(req.body?.status || "").toLowerCase();
    if (!["host", "partner"].includes(kind)) return res.status(400).json({ error: "bad_kind" });
    if (!["under_review", "approved", "rejected"].includes(next))
      return res.status(400).json({ error: "bad_status" });

    const db = readJSON(ONBOARD_FILE, { host: [], partner: [] });
    const list = db[kind] || [];
    const i = list.findIndex((r) => String(r.id) === id);
    if (i === -1) return res.status(404).json({ error: "not_found" });

    list[i].status = next;
    list[i].updatedAt = new Date().toISOString();
    db[kind] = list;
    writeJSON(ONBOARD_FILE, db);

    res.json({ ok: true, data: list[i] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "onboarding_update_failed" });
  }
});

export default router;
