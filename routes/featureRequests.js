// routes/featureRequests.js  (ESM)
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();

// --- simple JSON store (like routes/users.js) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, "..", "data", "feature_requests.json");

function ensureFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          requests: [
            // seed examples (optional — delete later)
            {
              id: "fr_1001",
              title: "Host calendar sync (iCal)",
              description: "Allow syncing with Google/Apple calendar.",
              by: "nesta.naija@gmail.com",
              priority: "medium", // low|medium|high|urgent
              status: "pending",  // pending|planned|shipped|rejected
              createdAt: Date.now() - 86400000 * 3,
              updatedAt: Date.now() - 86400000 * 3,
            },
            {
              id: "fr_1002",
              title: "Bulk photo uploader",
              description: "Drag & drop multi-image upload with reordering.",
              by: "johnagbike@yahoo.com",
              priority: "high",
              status: "planned",
              createdAt: Date.now() - 86400000 * 2,
              updatedAt: Date.now() - 86400000 * 2,
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );
  }
}
function loadAll() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, "utf8") || "{}";
  const parsed = JSON.parse(raw || "{}");
  return Array.isArray(parsed.requests) ? parsed.requests : [];
}
function saveAll(requests) {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify({ requests }, null, 2), "utf8");
}
function paginate(arr, page = 1, limit = 10) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const n = Math.max(1, parseInt(limit, 10) || 10);
  const start = (p - 1) * n;
  return { slice: arr.slice(start, start + n), page: p, limit: n, total: arr.length };
}

// GET /api/admin/feature-requests?status=all|pending|planned|shipped|rejected&q=&page=&limit=
router.get("/", (req, res) => {
  try {
    const { status = "all", q = "", page = 1, limit = 10 } = req.query;
    let rows = loadAll();

    if (status && status !== "all") {
      rows = rows.filter(r => (r.status || "pending") === status);
    }
    const needle = String(q || "").trim().toLowerCase();
    if (needle) {
      rows = rows.filter(r =>
        (r.title || "").toLowerCase().includes(needle) ||
        (r.by || "").toLowerCase().includes(needle) ||
        (r.id || "").toLowerCase().includes(needle)
      );
    }

    // sort newest first
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const { slice, page: p, limit: n, total } = paginate(rows, page, limit);
    res.json({ data: slice, page: p, limit: n, total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load feature requests" });
  }
});

// POST /api/admin/feature-requests
// { title, description?, by?, priority? }
router.post("/", (req, res) => {
  try {
    const { title, description = "", by = "", priority = "medium" } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: "Title is required" });
    }
    const now = Date.now();
    const requests = loadAll();
    const id = `fr_${now}`;
    const row = {
      id,
      title: String(title).trim(),
      description: String(description || "").trim(),
      by: String(by || "").trim(),
      priority: String(priority || "medium"),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    requests.unshift(row);
    saveAll(requests);
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to create feature request" });
  }
});

// PATCH /api/admin/feature-requests/:id
// { status?, priority?, title?, description? }
router.patch("/:id", (req, res) => {
  try {
    const { id } = req.params;
    const requests = loadAll();
    const idx = requests.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ message: "Not found" });

    const allowedStatus = ["pending", "planned", "shipped", "rejected"];
    const allowedPriority = ["low", "medium", "high", "urgent"];
    const body = req.body || {};
    const r = { ...requests[idx] };

    if (typeof body.status !== "undefined") {
      if (!allowedStatus.includes(body.status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      r.status = body.status;
    }
    if (typeof body.priority !== "undefined") {
      if (!allowedPriority.includes(body.priority)) {
        return res.status(400).json({ message: "Invalid priority" });
      }
      r.priority = body.priority;
    }
    if (typeof body.title !== "undefined") r.title = String(body.title || "").trim();
    if (typeof body.description !== "undefined") r.description = String(body.description || "").trim();

    r.updatedAt = Date.now();
    requests[idx] = r;
    saveAll(requests);
    res.json({ ok: true, data: r });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to update feature request" });
  }
});

// DELETE /api/admin/feature-requests/:id
router.delete("/:id", (req, res) => {
  try {
    const { id } = req.params;
    const requests = loadAll();
    const next = requests.filter(r => r.id !== id);
    if (next.length === requests.length) return res.status(404).json({ message: "Not found" });
    saveAll(next);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to delete feature request" });
  }
});

export default router;
