import { Router } from "express";
import { promises as fs } from "fs";
import path from "path";

const router = Router();

const file = path.join(process.cwd(), "adminSettings.json");

async function readJson() {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return { brandColor: "#F7B500", accentColor: "#6C63FF" }; }
}
async function writeJson(data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

router.get("/", async (_req, res) => {
  res.json(await readJson());
});

router.put("/", async (req, res) => {
  const current = await readJson();
  const next = { ...current, ...req.body, updatedAt: new Date().toISOString() };
  await writeJson(next);
  res.json(next);
});

export default router;