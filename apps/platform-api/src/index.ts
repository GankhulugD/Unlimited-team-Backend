import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as jose from "jose";
import { createDb, schema, type ThemeConfig } from "@unlimited-team/db";

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_BITS = 256;

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

app.use("*", async (c, next) => {
  if (c.env.DB == null) {
    return c.json({ error: "D1 binding (DB) is not configured" }, 503);
  }
  await next();
});

function uint8ToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += globalThis.String.fromCodePoint(bytes[i]!);
  return globalThis.btoa(binary);
}

function uint8FromB64(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) ?? 0;
  return out;
}

async function hashPassword(plain: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hashBuffer = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    PBKDF2_HASH_BITS,
  );
  const hash = new Uint8Array(hashBuffer);
  return `pbkdf2_v1$${PBKDF2_ITERATIONS}$${uint8ToB64(salt)}$${uint8ToB64(hash)}`;
}

async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_v1") return false;
  const iter = Number(parts[1]);
  if (!Number.isFinite(iter) || iter < 1) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = uint8FromB64(parts[2]!);
    expected = uint8FromB64(parts[3]!);
  } catch {
    return false;
  }
  const enc = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hashBuffer = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: iter,
      hash: "SHA-256",
    },
    keyMaterial,
    PBKDF2_HASH_BITS,
  );
  const actual = new Uint8Array(hashBuffer);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

type PublicUser = {
  id: string;
  email: string;
  role: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
};

async function signUserJwt(secret: string, user: PublicUser): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const claims: Record<string, string> = {
    email: user.email,
    role: user.role,
  };
  if (user.firstName) claims.firstName = user.firstName;
  if (user.lastName) claims.lastName = user.lastName;
  if (user.phone) claims.phone = user.phone;
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key);
}

function optionalTrimmedString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function rowToPublicUser(row: {
  id: string;
  email: string;
  role: "admin" | "merchant";
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}): PublicUser {
  const out: PublicUser = {
    id: row.id,
    email: row.email,
    role: row.role,
  };
  if (row.firstName) out.firstName = row.firstName;
  if (row.lastName) out.lastName = row.lastName;
  if (row.phone) out.phone = row.phone;
  return out;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

app.get("/", (c) => c.json({ service: "platform-api" }));

app.get("/admin/merchants", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(schema.users);
  return c.json(rows);
});

app.get("/admin/stores", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(schema.stores);
  return c.json(rows);
});

app.post("/auth/register", async (c) => {
  const jwtSecret = c.env.JWT_SECRET?.trim();
  if (!jwtSecret || jwtSecret.length < 16) {
    return c.json(
      { error: "JWT_SECRET is not configured (min 16 characters)" },
      503,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected JSON object" }, 400);
  }

  const b = body as Record<string, unknown>;
  const { email, password, role } = b;
  if (typeof email !== "string" || typeof password !== "string") {
    return c.json({ error: "email and password are required strings" }, 400);
  }

  const firstName =
    optionalTrimmedString(b.firstName) ??
    optionalTrimmedString(b.first_name);
  const lastName =
    optionalTrimmedString(b.lastName) ?? optionalTrimmedString(b.last_name);
  const phone = optionalTrimmedString(b.phone);

  if (!isValidEmail(email)) {
    return c.json({ error: "Invalid email" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }

  let resolvedRole: "admin" | "merchant" = "merchant";
  if (role !== undefined) {
    if (role !== "merchant" && role !== "admin") {
      return c.json({ error: "role must be merchant or admin" }, 400);
    }
    if (role === "admin") {
      return c.json(
        { error: "admin registration is not allowed on this endpoint" },
        403,
      );
    }
    resolvedRole = role;
  }

  const db = createDb(c.env.DB);
  const id = globalThis.crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const emailNorm = email.toLowerCase().trim();

  try {
    await db.insert(schema.users).values({
      id,
      email: emailNorm,
      password: passwordHash,
      role: resolvedRole,
      firstName,
      lastName,
      phone,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("UNIQUE constraint") ||
      message.toLowerCase().includes("unique")
    ) {
      return c.json({ error: "Email already registered" }, 409);
    }
    throw err;
  }

  const user: PublicUser = {
    id,
    email: emailNorm,
    role: resolvedRole,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(phone ? { phone } : {}),
  };
  let token: string;
  try {
    token = await signUserJwt(jwtSecret, user);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[auth/register] JWT sign failed", e);
    return c.json({ error: `JWT үүсэхэд алдаа: ${msg}` }, 500);
  }

  c.header("Cache-Control", "no-store");
  return c.json({ token, user }, 201);
});

app.post("/auth/login", async (c) => {
  const jwtSecret = c.env.JWT_SECRET?.trim();
  if (!jwtSecret || jwtSecret.length < 16) {
    return c.json(
      { error: "JWT_SECRET is not configured (min 16 characters)" },
      503,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected JSON object" }, 400);
  }

  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string") {
    return c.json({ error: "email and password are required strings" }, 400);
  }

  const emailNorm = email.toLowerCase().trim();
  const db = createDb(c.env.DB);
  const row = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, emailNorm))
    .get();

  if (!row) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const ok = await verifyPassword(password, row.password);
  if (!ok) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const user = rowToPublicUser(row);
  let token: string;
  try {
    token = await signUserJwt(jwtSecret, user);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[auth/login] JWT sign failed", e);
    return c.json({ error: `JWT үүсэхэд алдаа: ${msg}` }, 500);
  }

  c.header("Cache-Control", "no-store");
  return c.json({ token, user });
});

app.post("/stores", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected JSON object" }, 400);
  }

  const { ownerId, name, slug, themeConfig } = body as Record<string, unknown>;
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    return c.json({ error: "ownerId is required" }, 400);
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof slug !== "string" || slug.trim().length === 0) {
    return c.json({ error: "slug is required" }, 400);
  }

  const normalized = normalizeSlug(slug);
  if (normalized.length === 0) {
    return c.json({ error: "slug must contain letters or numbers" }, 400);
  }

  let theme: ThemeConfig = {};
  if (themeConfig !== undefined) {
    if (
      typeof themeConfig !== "object" ||
      themeConfig === null ||
      Array.isArray(themeConfig)
    ) {
      return c.json({ error: "themeConfig must be a JSON object" }, 400);
    }
    theme = themeConfig as ThemeConfig;
  }

  const db = createDb(c.env.DB);
  const owner = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .get();

  if (!owner) {
    return c.json({ error: "User not found" }, 404);
  }

  const storeId = globalThis.crypto.randomUUID();

  try {
    await db.insert(schema.stores).values({
      id: storeId,
      ownerId,
      name: name.trim(),
      slug: normalized,
      themeConfig: theme,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("UNIQUE constraint") ||
      message.toLowerCase().includes("unique")
    ) {
      return c.json({ error: "Store slug already in use" }, 409);
    }
    throw err;
  }

  const created = await db
    .select()
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .get();

  return c.json(created, 201);
});

export default app;
