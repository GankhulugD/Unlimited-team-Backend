import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, schema, type ThemeConfig } from "@unlimited-team/db";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type Bindings = {
  DB: D1Database;
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_UPLOAD_PRESET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (c, next) => {
  if (c.env.DB == null) {
    return c.json({ error: "D1 binding (DB) is not configured" }, 503);
  }
  await next();
});

function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function mergeTheme(current: ThemeConfig, patch: Partial<ThemeConfig>): ThemeConfig {
  return {
    ...current,
    ...patch,
    colors:
      patch.colors !== undefined
        ? { ...current.colors, ...patch.colors }
        : current.colors,
  };
}

app.get("/", (c) => c.json({ service: "merchant-api" }));

app.post("/upload", async (c) => {
  const cloudName = c.env.CLOUDINARY_CLOUD_NAME?.trim();
  const preset = c.env.CLOUDINARY_UPLOAD_PRESET?.trim();
  if (!cloudName || !preset) {
    return c.json({ error: "Cloudinary is not configured" }, 503);
  }

  let incoming: FormData;
  try {
    incoming = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid multipart body" }, 400);
  }

  const entry = incoming.get("file");
  if (!(entry instanceof File)) {
    return c.json({ error: 'Expected multipart form field "file" with a file' }, 400);
  }
  if (entry.size === 0) {
    return c.json({ error: "Empty file" }, 400);
  }
  if (entry.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: "File exceeds 5MB limit" }, 413);
  }

  const uploadForm = new FormData();
  uploadForm.append("file", entry);
  uploadForm.append("upload_preset", preset);

  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  const upstream = await fetch(endpoint, { method: "POST", body: uploadForm });

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return c.json({ error: "Invalid response from Cloudinary" }, 502);
  }

  if (!upstream.ok) {
    const obj = payload as Record<string, unknown>;
    const err = obj["error"];
    const message =
      err && typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : `Cloudinary upload failed (${upstream.status})`;
    return c.json({ error: message }, 502);
  }

  const secureUrl = (payload as Record<string, unknown>)["secure_url"];
  if (typeof secureUrl !== "string") {
    return c.json({ error: "Unexpected Cloudinary response" }, 502);
  }

  return c.json({ secure_url: secureUrl });
});

app.get("/storefront/:slug", async (c) => {
  const slugParam = c.req.param("slug");
  const normalized = normalizeSlug(slugParam);
  if (!normalized) {
    return c.json({ error: "Invalid slug" }, 400);
  }

  const db = createDb(c.env.DB);
  const store = await db
    .select({
      id: schema.stores.id,
      name: schema.stores.name,
      slug: schema.stores.slug,
      themeConfig: schema.stores.themeConfig,
    })
    .from(schema.stores)
    .where(eq(schema.stores.slug, normalized))
    .get();

  if (!store) {
    return c.json({ error: "Store not found" }, 404);
  }

  const products = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.storeId, store.id));

  return c.json({
    store,
    products,
  });
});

app.post("/products", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected JSON object" }, 400);
  }

  const { storeId, name, price, description, images } = body as Record<string, unknown>;

  if (typeof storeId !== "string" || storeId.length === 0) {
    return c.json({ error: "storeId is required" }, 400);
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof price !== "number" || !Number.isFinite(price) || !Number.isInteger(price) || price < 0) {
    return c.json({ error: "price must be a non-negative integer" }, 400);
  }

  let desc: string | null = null;
  if (description !== undefined) {
    if (description !== null && typeof description !== "string") {
      return c.json({ error: "description must be a string or null" }, 400);
    }
    desc = description === null ? null : description;
  }

  if (!Array.isArray(images)) {
    return c.json({ error: "images must be an array" }, 400);
  }
  if (!images.every((x) => typeof x === "string")) {
    return c.json({ error: "images must be an array of strings" }, 400);
  }

  const db = createDb(c.env.DB);
  const storeExists = await db
    .select({ id: schema.stores.id })
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .get();

  if (!storeExists) {
    return c.json({ error: "Store not found" }, 404);
  }

  const id = globalThis.crypto.randomUUID();
  await db.insert(schema.products).values({
    id,
    storeId,
    name: name.trim(),
    price,
    description: desc,
    images,
  });

  const created = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, id))
    .get();

  return c.json(created, 201);
});

app.patch("/stores/:id/theme", async (c) => {
  const storeId = c.req.param("id");
  if (!storeId?.length) {
    return c.json({ error: "Invalid store id" }, 400);
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

  const { themeConfig } = body as Record<string, unknown>;
  if (themeConfig === undefined) {
    return c.json({ error: "themeConfig is required" }, 400);
  }
  if (typeof themeConfig !== "object" || themeConfig === null || Array.isArray(themeConfig)) {
    return c.json({ error: "themeConfig must be an object" }, 400);
  }

  const patch = themeConfig as Partial<ThemeConfig>;

  const db = createDb(c.env.DB);
  const store = await db
    .select()
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .get();

  if (!store) {
    return c.json({ error: "Store not found" }, 404);
  }

  const nextTheme = mergeTheme(store.themeConfig, patch);

  await db
    .update(schema.stores)
    .set({ themeConfig: nextTheme })
    .where(eq(schema.stores.id, storeId));

  const updated = await db
    .select({
      id: schema.stores.id,
      ownerId: schema.stores.ownerId,
      name: schema.stores.name,
      slug: schema.stores.slug,
      themeConfig: schema.stores.themeConfig,
    })
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .get();

  return c.json(updated);
});

app.get("/orders/:storeId", async (c) => {
  const storeId = c.req.param("storeId");
  if (!storeId?.length) {
    return c.json({ error: "Invalid store id" }, 400);
  }

  const db = createDb(c.env.DB);
  const storeExists = await db
    .select({ id: schema.stores.id })
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .get();

  if (!storeExists) {
    return c.json({ error: "Store not found" }, 404);
  }

  const items = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.storeId, storeId));

  return c.json({ items });
});

export default app;
