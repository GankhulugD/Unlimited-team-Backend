import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, schema, type ThemeConfig } from "@unlimited-team/db";

type Bindings = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_BITS = 256;

function uint8ToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += globalThis.String.fromCodePoint(bytes[i]!);
  return globalThis.btoa(binary);
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
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    PBKDF2_HASH_BITS,
  );
  const hash = new Uint8Array(hashBuffer);
  return `pbkdf2_v1$${PBKDF2_ITERATIONS}$${uint8ToB64(salt)}$${uint8ToB64(hash)}`;
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

app.post("/auth/register", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected JSON object" }, 400);
  }

  const { email, password, role } = body as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string") {
    return c.json({ error: "email and password are required strings" }, 400);
  }

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
      return c.json({ error: "admin registration is not allowed on this endpoint" }, 403);
    }
    resolvedRole = role;
  }

  const db = createDb(c.env.DB);
  const id = globalThis.crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  try {
    await db.insert(schema.users).values({
      id,
      email: email.toLowerCase().trim(),
      password: passwordHash,
      role: resolvedRole,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint") || message.toLowerCase().includes("unique")) {
      return c.json({ error: "Email already registered" }, 409);
    }
    throw err;
  }

  return c.json(
    {
      id,
      email: email.toLowerCase().trim(),
      role: resolvedRole,
    },
    201,
  );
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
    if (typeof themeConfig !== "object" || themeConfig === null || Array.isArray(themeConfig)) {
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
    if (message.includes("UNIQUE constraint") || message.toLowerCase().includes("unique")) {
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
