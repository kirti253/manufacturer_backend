import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { pool, ensureSchema } from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3001;

/** Comma-separated browser origins allowed to call the API (e.g. admin app + public site). */
function normalizeOrigin(url) {
  const s = String(url).trim().replace(/\r/g, "");
  if (!s) return "";
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function parseAllowedOrigins() {
  const list = process.env.FRONTEND_URLS?.trim();
  if (list) {
    return list
      .split(",")
      .map((s) => normalizeOrigin(s))
      .filter(Boolean);
  }
  const single = normalizeOrigin(process.env.FRONTEND_URL);
  if (single) return [single];
  return ["http://localhost:3000", "http://localhost:3002"];
}

const allowedOrigins = new Set(parseAllowedOrigins());
/** Array form avoids node-cors bugs when denying dynamic origins (preflight must end in-framework). */
const allowedOriginsArray = Array.from(allowedOrigins);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

if (!ADMIN_PASSWORD || !JWT_SECRET) {
  console.error("Set ADMIN_PASSWORD and JWT_SECRET in .env");
  process.exit(1);
}

app.use(
  cors({
    origin: allowedOriginsArray,
    credentials: true,
  })
);

/** Lazy schema so OPTIONS/CORS never depends on DB (fixes Vercel cold start 500 on preflight). */
let schemaReadyPromise;
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (!schemaReadyPromise) {
    schemaReadyPromise = ensureSchema().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  schemaReadyPromise
    .then(() => next())
    .catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Database unavailable" });
      }
    });
});

app.use(express.json({ limit: "64kb" }));

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function basicEmailOk(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = header.slice(7);
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.post("/api/contact", async (req, res) => {
  const { name, email, subject, message } = req.body ?? {};

  if (!isNonEmptyString(name) || !isNonEmptyString(email) || !isNonEmptyString(message)) {
    return res.status(400).json({
      error: "name, email, and message are required",
    });
  }
  if (!basicEmailOk(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }

  const nameTrim = name.trim().slice(0, 255);
  const emailTrim = email.trim().toLowerCase().slice(0, 255);
  const subjectTrim =
    subject != null && isNonEmptyString(subject)
      ? subject.trim().slice(0, 500)
      : null;
  const messageTrim = message.trim().slice(0, 20000);

  try {
    const { rows } = await pool.query(
      `INSERT INTO contact_submissions (name, email, subject, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [nameTrim, emailTrim, subjectTrim, messageTrim]
    );
    return res.status(201).json({
      ok: true,
      id: rows[0].id,
      created_at: rows[0].created_at,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not save submission" });
  }
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== "string" || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "7d" });
  return res.json({ token, expiresIn: "7d" });
});

app.get("/api/admin/contacts", adminAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const countResult = await pool.query(
      "SELECT COUNT(*)::int AS total FROM contact_submissions"
    );
    const { rows } = await pool.query(
      `SELECT id, name, email, subject, message, created_at
       FROM contact_submissions
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.json({
      total: countResult.rows[0].total,
      limit,
      offset,
      items: rows,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not load submissions" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

async function main() {
  const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. If you wanted 5000, note: on macOS, AirPlay Receiver often binds to 5000 (System Settings → General → AirDrop & Handoff → AirPlay Receiver). Use another PORT in .env or free the port.`
      );
      process.exit(1);
    }
    throw err;
  });
}

if (process.env.VERCEL) {
  // Serverless: Vercel invokes the exported app; do not bind a port.
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export default app;
