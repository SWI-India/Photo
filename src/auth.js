const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db } = require("./db");

const jwtSecret = process.env.JWT_SECRET || "development-only-change-me";
const adminRoles = new Set(["super_admin", "admin", "ceo", "team_head"]);

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, email: user.email, role: user.role },
    jwtSecret,
    { expiresIn: "7d" }
  );
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in required." });

  try {
    const claims = jwt.verify(token, jwtSecret);
    const user = db.prepare(
      "SELECT id, name, email, role, active FROM users WHERE id = ?"
    ).get(claims.sub);
    if (!user?.active) return res.status(401).json({ error: "Account is inactive." });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

function requireAdmin(req, res, next) {
  if (!adminRoles.has(req.user.role)) {
    return res.status(403).json({ error: "Administrator access required." });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin access required." });
  }
  next();
}

async function seedAdmin() {
  const email = (process.env.INITIAL_ADMIN_EMAIL || "sindhjirasoi@gmail.com").toLowerCase();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return;

  const password = process.env.INITIAL_ADMIN_PASSWORD || "ChangeMe123!";
  const hash = await bcrypt.hash(password, 12);
  db.prepare(`
    INSERT INTO users (name, email, password_hash, role)
    VALUES (?, ?, ?, 'super_admin')
  `).run("SWI Super Admin", email, hash);
  console.log(`Created initial super administrator: ${email}`);
}

module.exports = { authenticate, requireAdmin, requireSuperAdmin, issueToken, seedAdmin, adminRoles };
