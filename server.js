require("node:fs").existsSync(".env") && process.loadEnvFile(".env");

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { db, getSetting, setSetting } = require("./src/db");
const { authenticate, requireAdmin, issueToken, seedAdmin } = require("./src/auth");
const { getOAuthClient, uploadReportBundle, getConnectionStatus } = require("./src/drive");

const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const uploadDir = process.env.UPLOAD_DIR || path.join(os.tmpdir(), "swi-field-reports-uploads");
const reportTypes = new Set(["Refill Visit", "General Visit", "Monitoring Visit"]);
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { files: 50, fileSize: 100 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    const allowed = file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/");
    callback(allowed ? null : new Error("Only photos and videos are allowed."), allowed);
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user?.active || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  res.json({
    token: issueToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  });
});

app.get("/api/me", authenticate, (req, res) => res.json(req.user));

app.post("/api/auth/change-password", authenticate, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ error: "New password must contain at least 10 characters." });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, req.user.id);
  res.json({ ok: true });
});

app.get("/api/villages", authenticate, (req, res) => {
  res.json(db.prepare("SELECT id, name FROM villages WHERE active = 1 ORDER BY name").all());
});

app.get("/api/reports", authenticate, (req, res) => {
  const where = req.user.role === "admin" ? "" : "WHERE r.user_id = ?";
  const params = req.user.role === "admin" ? [] : [req.user.id];
  const reports = db.prepare(`
    SELECT r.id, r.public_id, r.share_token, r.report_date, r.report_type, r.report_text, r.status,
           r.created_at, v.name AS village_name, u.name AS person_name,
           (SELECT COUNT(*) FROM media m WHERE m.report_id = r.id) AS media_count
    FROM reports r
    JOIN villages v ON v.id = r.village_id
    JOIN users u ON u.id = r.user_id
    ${where}
    ORDER BY r.created_at DESC
    LIMIT 100
  `).all(...params);
  res.json(reports.map((report) => ({
    ...report,
    shareUrl: `${appUrl}/report/${report.share_token}`
  })));
});

app.post("/api/reports", authenticate, upload.array("media", 50), async (req, res, next) => {
  const files = req.files || [];
  try {
    const villageId = Number(req.body.villageId);
    const reportType = String(req.body.reportType || "").trim();
    const reportText = String(req.body.report || "").trim();
    const reportDate = String(req.body.date || "");
    if (!villageId || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      return res.status(400).json({ error: "Village and report date are required." });
    }
    if (!reportTypes.has(reportType)) {
      return res.status(400).json({ error: "Please select a valid report type." });
    }
    if (!reportText || reportText.length > 3000) {
      return res.status(400).json({ error: "Report must contain 1 to 3,000 characters." });
    }
    if (files.length > 50) return res.status(400).json({ error: "Maximum 50 files allowed." });

    const village = db.prepare("SELECT id, name FROM villages WHERE id = ? AND active = 1").get(villageId);
    if (!village) return res.status(400).json({ error: "Please select an active village." });

    const publicId = crypto.randomUUID();
    const shareToken = crypto.randomBytes(24).toString("hex");
    const latitude = req.body.latitude ? Number(req.body.latitude) : null;
    const longitude = req.body.longitude ? Number(req.body.longitude) : null;
    const report = {
      personName: req.user.name,
      villageName: village.name,
      reportDate,
      reportType,
      reportText,
      submittedAt: new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date()),
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null
    };
    let mediaDates = [];
    try {
      mediaDates = JSON.parse(req.body.mediaDates || "[]");
    } catch {
      mediaDates = [];
    }
    files.forEach((file, index) => {
      const parsedDate = new Date(mediaDates[index]);
      if (!Number.isNaN(parsedDate.getTime())) {
        file.captureDate = new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          dateStyle: "medium",
          timeStyle: "short"
        }).format(parsedDate);
      }
    });
    const driveResult = await uploadReportBundle(report, files);

    const result = db.prepare(`
      INSERT INTO reports (
        public_id, share_token, user_id, village_id, report_date, report_text,
        report_type,
        latitude, longitude, drive_folder_id, drive_document_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      publicId, shareToken, req.user.id, village.id, reportDate, reportText, reportType,
      report.latitude, report.longitude, driveResult.folderId, driveResult.documentId
    );
    const insertMedia = db.prepare(`
      INSERT INTO media (report_id, original_name, mime_type, drive_file_id, public_url)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const item of driveResult.media) {
      insertMedia.run(result.lastInsertRowid, item.originalName, item.mimeType, item.driveFileId, item.publicUrl);
    }

    res.status(201).json({
      id: Number(result.lastInsertRowid),
      shareUrl: `${appUrl}/report/${shareToken}`
    });
  } catch (error) {
    next(error);
  } finally {
    for (const file of files) fs.rm(file.path, { force: true }, () => {});
  }
});

app.get("/api/public/reports/:token", (req, res) => {
  const report = db.prepare(`
    SELECT r.report_date, r.report_type, r.report_text, r.latitude, r.longitude, r.created_at,
           v.name AS village_name, u.name AS person_name
    FROM reports r
    JOIN villages v ON v.id = r.village_id
    JOIN users u ON u.id = r.user_id
    WHERE r.share_token = ? AND r.status = 'submitted'
  `).get(req.params.token);
  if (!report) return res.status(404).json({ error: "Report not found or link disabled." });
  report.media = db.prepare(`
    SELECT original_name, mime_type, public_url, drive_file_id
    FROM media
    WHERE report_id = (
      SELECT id FROM reports WHERE share_token = ?
    )
    ORDER BY id
  `).all(req.params.token).map((item) => ({
    ...item,
    thumbnail_url: item.mime_type.startsWith("image/")
      ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.drive_file_id)}&sz=w1600`
      : null
  }));
  res.json(report);
});

app.get("/api/public/villages/:token", (req, res) => {
  const village = db.prepare(
    "SELECT id, name FROM villages WHERE share_token = ?"
  ).get(req.params.token);
  if (!village) return res.status(404).json({ error: "Village link not found." });
  const reports = db.prepare(`
    SELECT r.report_date, r.report_type, r.report_text, r.share_token, r.created_at,
           u.name AS person_name,
           (SELECT COUNT(*) FROM media m WHERE m.report_id = r.id) AS media_count
    FROM reports r
    JOIN users u ON u.id = r.user_id
    WHERE r.village_id = ? AND r.status = 'submitted'
    ORDER BY r.report_date DESC, r.created_at DESC
  `).all(village.id).map((report) => ({
    ...report,
    shareUrl: `${appUrl}/report/${report.share_token}`
  }));
  res.json({ village: village.name, reports });
});

app.get("/api/admin/users", authenticate, requireAdmin, (req, res) => {
  res.json(db.prepare(
    "SELECT id, name, email, role, active, created_at FROM users ORDER BY name"
  ).all());
});

app.post("/api/admin/users", authenticate, requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "field";
  if (!name || !email.includes("@") || password.length < 8) {
    return res.status(400).json({ error: "Name, valid email and an 8-character password are required." });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)"
    ).run(name, email, hash, role);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That email is already registered." });
    }
    throw error;
  }
});

app.patch("/api/admin/users/:id", authenticate, requireAdmin, (req, res) => {
  const active = req.body.active ? 1 : 0;
  db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active, Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/admin/villages", authenticate, requireAdmin, (req, res) => {
  const villages = db.prepare(
    "SELECT id, name, active, share_token FROM villages ORDER BY name"
  ).all();
  res.json(villages.map((village) => ({
    ...village,
    shareUrl: `${appUrl}/village/${village.share_token}`
  })));
});

app.post("/api/admin/villages", authenticate, requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Village name is required." });
  try {
    const shareToken = crypto.randomBytes(24).toString("hex");
    const result = db.prepare("INSERT INTO villages (name, share_token) VALUES (?, ?)").run(name, shareToken);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: "That village already exists." });
  }
});

app.patch("/api/admin/villages/:id", authenticate, requireAdmin, (req, res) => {
  db.prepare("UPDATE villages SET active = ? WHERE id = ?")
    .run(req.body.active ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/admin/google/status", authenticate, requireAdmin, async (req, res, next) => {
  try {
    res.json(await getConnectionStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/google/connect", authenticate, requireAdmin, (req, res) => {
  const client = getOAuthClient();
  if (!client) {
    return res.status(503).json({ error: "Google OAuth client ID and secret are not configured." });
  }
  const state = crypto.randomBytes(20).toString("hex");
  setSetting("google_oauth_state", state);
  res.json({
    url: client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      state,
      scope: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/userinfo.email"
      ]
    })
  });
});

app.get("/api/admin/google/callback", async (req, res, next) => {
  try {
    if (!req.query.code || req.query.state !== getSetting("google_oauth_state")) {
      return res.status(400).send("Invalid Google authorization response.");
    }
    const client = getOAuthClient();
    const { tokens } = await client.getToken(req.query.code);
    if (tokens.refresh_token) setSetting("google_refresh_token", tokens.refresh_token);
    client.setCredentials(tokens);
    const profile = await require("googleapis").google.oauth2({ version: "v2", auth: client }).userinfo.get();
    setSetting("google_account_email", profile.data.email || "");
    setSetting("drive_root_folder_id", "");
    res.redirect("/?google=connected");
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/google/disconnect", authenticate, requireAdmin, (req, res) => {
  setSetting("google_refresh_token", "");
  setSetting("google_account_email", "");
  setSetting("drive_root_folder_id", "");
  res.json({ ok: true });
});

app.get("/report/:token", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "report.html"));
});

app.get("/village/:token", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "village.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE"
      ? "Each file must be 100 MB or smaller."
      : "Maximum 50 files are allowed." });
  }
  res.status(error.code === "DRIVE_NOT_CONNECTED" ? 503 : 500).json({
    error: error.message || "Unexpected server error."
  });
});

seedAdmin().then(() => {
  app.listen(port, () => console.log(`SWI Field Reports running at ${appUrl}`));
});
