require("dotenv").config();
const express = require("express");
const cors    = require("express");
const path    = require("path");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const app     = require("express")();

app.use(require("cors")());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Database ──────────────────────────────────────────────────
const db = new sqlite3.Database("popup_tracker.db", (err) => {
  if (err) { console.error("❌ DB error:", err.message); process.exit(1); }
  console.log("✅  Database ready.");
});

db.serialize(() => {
  // Campaign state — single row
  db.run(`
    CREATE TABLE IF NOT EXISTS campaign (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      active   INTEGER DEFAULT 0,
      title    TEXT DEFAULT 'Security Alert',
      started_at DATETIME,
      stopped_at DATETIME
    )
  `);
  db.run(`INSERT OR IGNORE INTO campaign (id, active) VALUES (1, 0)`);

  // One row per device
  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id  TEXT PRIMARY KEY,
      ip         TEXT,
      user_agent TEXT,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Every button click event
  db.run(`
    CREATE TABLE IF NOT EXISTS clicks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id  TEXT NOT NULL,
      button     TEXT NOT NULL,
      clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ── DB helpers ────────────────────────────────────────────────
const dbRun = (sql, p=[]) => new Promise((res,rej) => db.run(sql,p,function(e){e?rej(e):res(this);}));
const dbAll = (sql, p=[]) => new Promise((res,rej) => db.all(sql,p,(e,r)=>{e?rej(e):res(r);}));
const dbGet = (sql, p=[]) => new Promise((res,rej) => db.get(sql,p,(e,r)=>{e?rej(e):res(r);}));

// ── Admin auth middleware ──────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized. Wrong admin password." });
  }
  next();
}

// =============================================================
//  PUBLIC ROUTES (no auth — used by popup page on user devices)
// =============================================================

// GET /api/campaign/status
// User device polls this to know if campaign is active
app.get("/api/campaign/status", async (req, res) => {
  const row = await dbGet("SELECT active, title FROM campaign WHERE id = 1");
  res.json({ active: row.active === 1, title: row.title });
});

// POST /api/device/register
// Called once when a user visits — registers their device, returns device_id
app.post("/api/device/register", async (req, res) => {
  const { device_id } = req.body;
  const ip        = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const userAgent = req.headers["user-agent"] || "";

  let finalId = device_id;

  if (device_id) {
    // Already known device — update last_seen
    const existing = await dbGet("SELECT device_id FROM devices WHERE device_id = ?", [device_id]);
    if (existing) {
      await dbRun(
        "UPDATE devices SET last_seen = CURRENT_TIMESTAMP, ip = ? WHERE device_id = ?",
        [ip, device_id]
      );
    } else {
      // ID sent but not in DB — re-register
      finalId = uuidv4();
      await dbRun(
        "INSERT INTO devices (device_id, ip, user_agent) VALUES (?, ?, ?)",
        [finalId, ip, userAgent]
      );
    }
  } else {
    // Brand new device
    finalId = uuidv4();
    await dbRun(
      "INSERT INTO devices (device_id, ip, user_agent) VALUES (?, ?, ?)",
      [finalId, ip, userAgent]
    );
  }

  res.json({ device_id: finalId });
});

// POST /api/click
// Records a button click from a user device
app.post("/api/click", async (req, res) => {
  const { device_id, button } = req.body;
  const validButtons = ["reset", "close", "report"];

  if (!device_id || !validButtons.includes(button)) {
    return res.status(400).json({ error: "Invalid request." });
  }

  // Only count clicks if campaign is active
  const campaign = await dbGet("SELECT active FROM campaign WHERE id = 1");
  if (!campaign.active) {
    return res.status(403).json({ error: "No active campaign." });
  }

  await dbRun(
    "INSERT INTO clicks (device_id, button) VALUES (?, ?)",
    [device_id, button]
  );

  res.json({ success: true });
});

// =============================================================
//  ADMIN ROUTES (require x-admin-token header)
// =============================================================

// POST /api/admin/login
// Validate admin password
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, token: process.env.ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: "Wrong password." });
  }
});

// POST /api/admin/campaign/start
app.post("/api/admin/campaign/start", adminAuth, async (req, res) => {
  const { title } = req.body;
  await dbRun(
    "UPDATE campaign SET active = 1, title = ?, started_at = CURRENT_TIMESTAMP, stopped_at = NULL WHERE id = 1",
    [title || "Security Alert"]
  );
  console.log("🟢  Campaign STARTED");
  res.json({ success: true, message: "Campaign started. Popup will now show on all devices." });
});

// POST /api/admin/campaign/stop
app.post("/api/admin/campaign/stop", adminAuth, async (req, res) => {
  await dbRun(
    "UPDATE campaign SET active = 0, stopped_at = CURRENT_TIMESTAMP WHERE id = 1"
  );
  console.log("🔴  Campaign STOPPED");
  res.json({ success: true, message: "Campaign stopped." });
});

// GET /api/admin/stats
// Overall button click totals
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  const campaign = await dbGet("SELECT * FROM campaign WHERE id = 1");
  const totals   = await dbAll(`
    SELECT button, COUNT(*) as clicks
    FROM clicks GROUP BY button
  `);
  const deviceCount = await dbGet("SELECT COUNT(*) as count FROM devices");
  const totalClicks = await dbGet("SELECT COUNT(*) as count FROM clicks");

  res.json({
    campaign,
    totals,
    deviceCount: deviceCount.count,
    totalClicks: totalClicks.count
  });
});

// GET /api/admin/devices
// Per-device report — each device with all their clicks
app.get("/api/admin/devices", adminAuth, async (req, res) => {
  const devices = await dbAll(`
    SELECT d.device_id, d.ip, d.user_agent, d.first_seen, d.last_seen,
           COUNT(c.id) as total_clicks
    FROM devices d
    LEFT JOIN clicks c ON d.device_id = c.device_id
    GROUP BY d.device_id
    ORDER BY d.last_seen DESC
  `);

  // For each device, get their individual button breakdown
  for (const device of devices) {
    device.buttons = await dbAll(`
      SELECT button, COUNT(*) as count
      FROM clicks WHERE device_id = ?
      GROUP BY button
    `, [device.device_id]);
  }

  res.json(devices);
});

// GET /api/admin/device/:id
// Full click history for one device
app.get("/api/admin/device/:id", adminAuth, async (req, res) => {
  const device = await dbGet("SELECT * FROM devices WHERE device_id = ?", [req.params.id]);
  if (!device) return res.status(404).json({ error: "Device not found." });

  const clicks = await dbAll(
    "SELECT button, clicked_at FROM clicks WHERE device_id = ? ORDER BY clicked_at DESC",
    [req.params.id]
  );

  res.json({ device, clicks });
});

// DELETE /api/admin/reset
// Clear all data
app.delete("/api/admin/reset", adminAuth, async (req, res) => {
  await dbRun("DELETE FROM clicks");
  await dbRun("DELETE FROM devices");
  await dbRun("UPDATE campaign SET active=0, started_at=NULL, stopped_at=NULL WHERE id=1");
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n✅  Popup Tracker running → http://localhost:${PORT}`);
  console.log(`   Popup page  → http://localhost:${PORT}/popup.html`);
  console.log(`   Admin login → http://localhost:${PORT}/admin.html\n`);
});