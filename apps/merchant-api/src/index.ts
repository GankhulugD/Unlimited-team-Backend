import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDb, schema, type ThemeConfig } from "@unlimited-team/db";

/** 5 MiB (5 × 1024² байт) — зургийн upload хэмжээний дээд хязгаар. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type Bindings = {
  DB: D1Database;
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_UPLOAD_PRESET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

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

function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/** Жишээ: `tech-store-tdp8xs` — нэр + 6 тэмдэгтийн суффикс. */
function randomSlugSuffix(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 6);
}

async function allocateUniqueStoreSlug(
  db: ReturnType<typeof createDb>,
  baseRaw: string,
  storeId: string,
  previousSlug: string,
): Promise<string> {
  let base = normalizeSlug(baseRaw);
  if (!base.length) base = "shop";
  if (base.length > 48) base = base.slice(0, 48);
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = `${base}-${randomSlugSuffix()}`;
    const taken = await db
      .select({ id: schema.stores.id })
      .from(schema.stores)
      .where(eq(schema.stores.slug, candidate))
      .get();
    if (!taken) return candidate;
    if (taken.id === storeId) {
      if (candidate === previousSlug) continue;
      return candidate;
    }
  }
  return `${base}-${randomSlugSuffix()}${randomSlugSuffix()}`;
}

const SITE_THEME_PRESETS = ["minimal", "glass", "neumorph"] as const;

function clampNum(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Theme studio → D1: зөвхөн whitelist (бусад түлхүүр устгана). */
function normalizeSiteThemeForDb(input: unknown): Record<string, unknown> {
  const emptyLayout = () => ({
    radiusPx: 12,
    cardContentPaddingRem: 1,
    productGridGapRem: 1,
    heroImageHeightPx: 240,
  });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      builderTheme: "minimal",
      heroTitle: "",
      shopName: "",
      layout: emptyLayout(),
      heroGallery: [],
    };
  }

  const o = input as Record<string, unknown>;
  const bt =
    typeof o.builderTheme === "string" &&
    (SITE_THEME_PRESETS as readonly string[]).includes(o.builderTheme)
      ? o.builderTheme
      : "minimal";

  const heroTitle = typeof o.heroTitle === "string" ? o.heroTitle : "";
  const shopName = typeof o.shopName === "string" ? o.shopName : "";

  const gallery = Array.isArray(o.heroGallery)
    ? o.heroGallery
        .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
        .map((s) => s.trim())
    : [];

  let layout = emptyLayout();
  const L = o.layout;
  if (L && typeof L === "object" && !Array.isArray(L)) {
    const l = L as Record<string, unknown>;
    layout = {
      radiusPx: Math.round(
        clampNum(
          typeof l.radiusPx === "number" && Number.isFinite(l.radiusPx)
            ? l.radiusPx
            : 12,
          2,
          48,
        ),
      ),
      cardContentPaddingRem: clampNum(
        typeof l.cardContentPaddingRem === "number" &&
          Number.isFinite(l.cardContentPaddingRem)
          ? l.cardContentPaddingRem
          : 1,
        0.5,
        2,
      ),
      productGridGapRem: clampNum(
        typeof l.productGridGapRem === "number" &&
          Number.isFinite(l.productGridGapRem)
          ? l.productGridGapRem
          : 1,
        0.375,
        2.5,
      ),
      heroImageHeightPx: Math.round(
        clampNum(
          typeof l.heroImageHeightPx === "number" &&
            Number.isFinite(l.heroImageHeightPx)
            ? l.heroImageHeightPx
            : 240,
          40,
          900,
        ),
      ),
    };
  }

  return {
    builderTheme: bt,
    heroTitle,
    shopName,
    layout,
    heroGallery: gallery,
  };
}

function mergeTheme(
  current: ThemeConfig,
  patch: Partial<ThemeConfig>,
): ThemeConfig {
  return {
    ...current,
    ...patch,
    colors:
      patch.colors !== undefined
        ? { ...current.colors, ...patch.colors }
        : current.colors,
  };
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

type StoreRow = typeof schema.stores.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;
type OrderRow = typeof schema.orders.$inferSelect;

function shopJsonFromStoreRow(row: StoreRow) {
  const theme = row.themeConfig ?? {};
  const colors = theme.colors ?? {};
  const brand =
    typeof colors.brand === "string"
      ? colors.brand
      : typeof colors.brandColor === "string"
        ? colors.brandColor
        : "#18181b";
  const accent =
    typeof colors.accent === "string"
      ? colors.accent
      : typeof colors.accentColor === "string"
        ? colors.accentColor
        : "#f4f4f5";
  const cur = theme.currency;
  const currency =
    cur === "USD" || cur === "EUR" || cur === "MNT" ? cur : "USD";

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerId: row.ownerId,
    logoUrl: typeof theme.logoUrl === "string" ? theme.logoUrl : "",
    brandColor: brand,
    accentColor: accent,
    currency,
    themeConfig: row.themeConfig ?? {},
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function productJsonFromRow(row: ProductRow) {
  const images = row.images ?? [];
  const statusUi = row.status === "draft" ? "Draft" : "Live";
  return {
    id: row.id,
    shopId: row.storeId,
    name: row.name,
    sku: row.sku ?? "",
    category: (row.category ?? "").trim() || "General",
    size: row.size ?? "",
    description: row.description ?? "",
    imageUrl: images[0] ?? "",
    status: statusUi,
    price: row.price,
    inventory: row.inventory ?? 0,
    sales: row.salesCount ?? 0,
    earning: row.revenue ?? 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function simpleIdPart(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 12);
}

function monthlySalesFromOrders(
  orders: OrderRow[],
  storeId: string,
  year: number,
) {
  const totals = new Array(12).fill(0);
  for (const o of orders) {
    if (o.storeId !== storeId) continue;
    if (o.status === "cancelled") continue;
    const t = Date.parse(o.createdAt);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    if (d.getUTCFullYear() !== year) continue;
    totals[d.getUTCMonth()] += o.totalPrice;
  }
  return MONTH_LABELS.map((month, i) => ({
    shopId: storeId,
    month,
    sales: totals[i] ?? 0,
  }));
}

function customersFromOrders(orders: OrderRow[], storeId: string) {
  type Agg = { email: string; name: string; orders: number; ltv: number };
  const map = new Map<string, Agg>();
  for (const o of orders) {
    if (o.storeId !== storeId) continue;
    if (o.status === "cancelled") continue;
    const rawEmail = (o.customerInfo?.email ?? "").trim().toLowerCase();
    if (!rawEmail) continue;
    const nameRaw = (o.customerInfo?.name ?? "").trim();
    const displayName =
      nameRaw ||
      rawEmail.split("@")[0]?.replace(/[._]/g, " ") ||
      "Customer";
    const cur = map.get(rawEmail);
    if (cur) {
      cur.orders += 1;
      cur.ltv += o.totalPrice;
      if (!cur.name && displayName) cur.name = displayName;
    } else {
      map.set(rawEmail, {
        email: rawEmail,
        name: displayName,
        orders: 1,
        ltv: o.totalPrice,
      });
    }
  }
  const seedBase = "https://api.dicebear.com/7.x/avataaars/svg?seed=";
  return [...map.values()].map((c) => ({
    id: `cust_${simpleIdPart(c.email)}`,
    shopId: storeId,
    name: c.name,
    email: c.email,
    avatarUrl: `${seedBase}${encodeURIComponent(c.email)}`,
    totalOrders: c.orders,
    lifetimeValue: c.ltv,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  }));
}

function parseDbProductStatus(v: unknown): "live" | "draft" {
  if (v === undefined || v === null) return "live";
  if (v === "Live" || v === "live") return "live";
  if (v === "Draft" || v === "draft") return "draft";
  return "live";
}

app.get("/", (c) => c.json({ service: "merchant-api" }));

/**
 * **Admin query.** Бүх мерчантын нийт барааг (`products`) өгөгдлийн сангаас жагсаалтаар буцаана.
 * Drizzle: `.select().from(products)`.
 */
app.get("/admin/products", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(schema.products);
  return c.json(rows);
});

/**
 * **Admin query.** Нийт мерчант (`role = merchant`), дэлгүүр, барааны тоог `.select(...).from(...)` ашиглан тоолж буцаана.
 */
app.get("/admin/stats", async (c) => {
  const db = createDb(c.env.DB);

  const [merchantCount] = await db
    .select({ total: count() })
    .from(schema.users)
    .where(eq(schema.users.role, "merchant"));

  const [storeCount] = await db.select({ total: count() }).from(schema.stores);

  const [productCount] = await db.select({ total: count() }).from(schema.products);

  return c.json({
    totalMerchants: merchantCount?.total ?? 0,
    totalStores: storeCount?.total ?? 0,
    totalProducts: productCount?.total ?? 0,
  });
});

/** Admin: бүх дэлгүүрийн жагсаалт (dashboard switcher). */
app.get("/admin/stores", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(schema.stores);
  return c.json(rows.map(shopJsonFromStoreRow));
});

/** Admin: нэг дэлгүүрийн dashboard өгөгдөл (бараа, ангилал, захиалгаас үйлчлүүлэгч, сарын борлуулалт). */
app.get("/admin/stores/:storeId/dashboard", async (c) => {
  const storeId = c.req.param("storeId");
  if (!storeId?.length) {
    return c.json({ error: "Invalid store id" }, 400);
  }

  const db = createDb(c.env.DB);
  const store = await db
    .select()
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .get();

  if (!store) {
    return c.json({ error: "Store not found" }, 404);
  }

  const [productRows, categoryRows, orderRows] = await Promise.all([
    db.select().from(schema.products).where(eq(schema.products.storeId, storeId)),
    db
      .select({ name: schema.storeCategories.name })
      .from(schema.storeCategories)
      .where(eq(schema.storeCategories.storeId, storeId)),
    db.select().from(schema.orders).where(eq(schema.orders.storeId, storeId)),
  ]);

  const year = new Date().getUTCFullYear();
  const categories = categoryRows.map((r) => r.name).sort((a, b) => a.localeCompare(b));
  const monthlySales = monthlySalesFromOrders(orderRows, storeId, year);
  const customers = customersFromOrders(orderRows, storeId);

  return c.json({
    store: shopJsonFromStoreRow(store),
    products: productRows.map(productJsonFromRow),
    categories,
    customers,
    monthlySales,
  });
});

/** Admin: дэлгүүрийн нэр, slug, брэнд (theme) шинэчлэх. */
app.patch("/admin/stores/:storeId", async (c) => {
  const storeId = c.req.param("storeId");
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

  const b = body as Record<string, unknown>;
  const db = createDb(c.env.DB);
  const store = await db
    .select()
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .get();

  if (!store) {
    return c.json({ error: "Store not found" }, 404);
  }

  let nextName = store.name;
  let nextSlug = store.slug;
  let nextTheme = store.themeConfig;

  if (typeof b.name === "string" && b.name.trim().length > 0) {
    nextName = b.name.trim();
  }

  if (typeof b.slug === "string" && b.slug.trim().length > 0) {
    const normalized = normalizeSlug(b.slug);
    if (!normalized.length) {
      return c.json({ error: "slug must contain letters or numbers" }, 400);
    }
    if (normalized !== store.slug) {
      const taken = await db
        .select({ id: schema.stores.id })
        .from(schema.stores)
        .where(eq(schema.stores.slug, normalized))
        .get();
      if (taken && taken.id !== storeId) {
        return c.json({ error: "Store slug already in use" }, 409);
      }
    }
    nextSlug = normalized;
  }

  const colorPatch: Record<string, string> = {};
  if (typeof b.brandColor === "string" && b.brandColor.trim()) {
    colorPatch.brand = b.brandColor.trim();
  }
  if (typeof b.accentColor === "string" && b.accentColor.trim()) {
    colorPatch.accent = b.accentColor.trim();
  }

  const themePatch: Partial<ThemeConfig> = {};
  if (typeof b.logoUrl === "string") {
    themePatch.logoUrl = b.logoUrl.trim();
  }
  if (Object.keys(colorPatch).length > 0) {
    themePatch.colors = colorPatch;
  }
  if (
    b.currency === "USD" ||
    b.currency === "EUR" ||
    b.currency === "MNT"
  ) {
    themePatch.currency = b.currency;
  }

  if (Object.keys(themePatch).length > 0) {
    nextTheme = mergeTheme(nextTheme, themePatch);
  }

  await db
    .update(schema.stores)
    .set({
      name: nextName,
      slug: nextSlug,
      themeConfig: nextTheme,
    })
    .where(eq(schema.stores.id, storeId));

  const updated = await db
    .select()
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .get();

  return c.json(shopJsonFromStoreRow(updated!));
});

/** Admin: дэлгүүрийн ангилал нэмэх. */
app.post("/admin/stores/:storeId/categories", async (c) => {
  const storeId = c.req.param("storeId");
  if (!storeId?.length) {
    return c.json({ error: "Invalid store id" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name =
    body &&
    typeof body === "object" &&
    typeof (body as { name?: unknown }).name === "string"
      ? (body as { name: string }).name.trim()
      : "";

  if (!name.length) {
    return c.json({ error: "name is required" }, 400);
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

  try {
    await db.insert(schema.storeCategories).values({ storeId, name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("UNIQUE") ||
      message.toLowerCase().includes("unique")
    ) {
      return c.json({ error: "Category already exists" }, 409);
    }
    throw err;
  }

  const rows = await db
    .select({ name: schema.storeCategories.name })
    .from(schema.storeCategories)
    .where(eq(schema.storeCategories.storeId, storeId));

  return c.json({
    categories: rows.map((r) => r.name).sort((a, b) => a.localeCompare(b)),
  });
});

/** Admin: дэлгүүрийн ангилал устгах. */
app.delete("/admin/stores/:storeId/categories", async (c) => {
  const storeId = c.req.param("storeId");
  const name = c.req.query("name")?.trim() ?? "";
  if (!storeId?.length || !name.length) {
    return c.json({ error: "storeId and name query are required" }, 400);
  }

  const db = createDb(c.env.DB);
  await db
    .delete(schema.storeCategories)
    .where(
      and(
        eq(schema.storeCategories.storeId, storeId),
        eq(schema.storeCategories.name, name),
      ),
    );

  const rows = await db
    .select({ name: schema.storeCategories.name })
    .from(schema.storeCategories)
    .where(eq(schema.storeCategories.storeId, storeId));

  return c.json({
    categories: rows.map((r) => r.name).sort((a, b) => a.localeCompare(b)),
  });
});

/** Admin: бараа нэмэх. */
app.post("/admin/stores/:storeId/products", async (c) => {
  const storeId = c.req.param("storeId");
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

  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name.length) {
    return c.json({ error: "name is required" }, 400);
  }

  const price = b.price;
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    !Number.isInteger(price) ||
    price < 0
  ) {
    return c.json({ error: "price must be a non-negative integer" }, 400);
  }

  const imageUrl = typeof b.imageUrl === "string" ? b.imageUrl.trim() : "";
  if (!imageUrl.length) {
    return c.json({ error: "imageUrl is required" }, 400);
  }

  const sku = typeof b.sku === "string" ? b.sku.trim() : "";
  const category =
    typeof b.category === "string" && b.category.trim()
      ? b.category.trim()
      : "General";
  const size = typeof b.size === "string" ? b.size.trim() : "";
  const description =
    typeof b.description === "string" ? b.description.trim() : "";

  const st = parseDbProductStatus(b.status);

  const inv = b.inventory;
  if (
    typeof inv !== "number" ||
    !Number.isFinite(inv) ||
    !Number.isInteger(inv) ||
    inv < 0
  ) {
    return c.json({ error: "inventory must be a non-negative integer" }, 400);
  }

  const db = createDb(c.env.DB);
  const storeRow = await db
    .select({ id: schema.stores.id, slug: schema.stores.slug })
    .from(schema.stores)
    .where(eq(schema.stores.id, storeId))
    .get();

  if (!storeRow) {
    return c.json({ error: "Store not found" }, 404);
  }

  const id = globalThis.crypto.randomUUID();
  const slugPrefix = (storeRow.slug ?? "shop")
    .replace(/[^a-z0-9]+/gi, "")
    .slice(0, 4)
    .toUpperCase();
  const finalSku =
    sku || `SKU-${slugPrefix || "SHOP"}-${Date.now().toString().slice(-6)}`;

  await db.insert(schema.products).values({
    id,
    storeId,
    name,
    price,
    description: description.length ? description : null,
    images: [imageUrl],
    sku: finalSku,
    category,
    size,
    status: st,
    inventory: inv,
    salesCount: 0,
    revenue: 0,
  });

  if (category) {
    try {
      await db.insert(schema.storeCategories).values({ storeId, name: category });
    } catch {
      /* already exists */
    }
  }

  const created = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, id))
    .get();

  return c.json(productJsonFromRow(created!), 201);
});

/** Admin: бараа засах. */
app.patch("/admin/stores/:storeId/products/:productId", async (c) => {
  const storeId = c.req.param("storeId");
  const productId = c.req.param("productId");
  if (!storeId?.length || !productId?.length) {
    return c.json({ error: "Invalid store or product id" }, 400);
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
  const db = createDb(c.env.DB);
  const row = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .get();

  if (!row || row.storeId !== storeId) {
    return c.json({ error: "Product not found" }, 404);
  }

  const patch: Partial<typeof schema.products.$inferInsert> = {};

  if (typeof b.name === "string" && b.name.trim()) {
    patch.name = b.name.trim();
  }
  if (typeof b.sku === "string") {
    patch.sku = b.sku.trim();
  }
  if (typeof b.category === "string" && b.category.trim()) {
    patch.category = b.category.trim();
  }
  if (typeof b.size === "string") {
    patch.size = b.size.trim();
  }
  if (typeof b.description === "string") {
    patch.description = b.description.trim().length
      ? b.description.trim()
      : null;
  }
  if (typeof b.imageUrl === "string" && b.imageUrl.trim()) {
    patch.images = [b.imageUrl.trim()];
  }
  if (b.status !== undefined) {
    const st = parseDbProductStatus(b.status);
    patch.status = st;
  }
  if (
    typeof b.price === "number" &&
    Number.isInteger(b.price) &&
    b.price >= 0
  ) {
    patch.price = b.price;
  }
  if (
    typeof b.inventory === "number" &&
    Number.isInteger(b.inventory) &&
    b.inventory >= 0
  ) {
    patch.inventory = b.inventory;
  }

  if (Object.keys(patch).length === 0) {
    return c.json(productJsonFromRow(row));
  }

  await db
    .update(schema.products)
    .set(patch)
    .where(eq(schema.products.id, productId));

  if (typeof patch.category === "string" && patch.category.length) {
    try {
      await db
        .insert(schema.storeCategories)
        .values({ storeId, name: patch.category });
    } catch {
      /* exists */
    }
  }

  const updated = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .get();

  return c.json(productJsonFromRow(updated!));
});

/** Admin: бараа устгах. */
app.delete("/admin/stores/:storeId/products/:productId", async (c) => {
  const storeId = c.req.param("storeId");
  const productId = c.req.param("productId");
  if (!storeId?.length || !productId?.length) {
    return c.json({ error: "Invalid store or product id" }, 400);
  }

  const db = createDb(c.env.DB);
  const row = await db
    .select({ id: schema.products.id, storeId: schema.products.storeId })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .get();

  if (!row || row.storeId !== storeId) {
    return c.json({ error: "Product not found" }, 404);
  }

  await db.delete(schema.products).where(eq(schema.products.id, productId));
  return c.json({ ok: true });
});

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
    return c.json(
      { error: 'Expected multipart form field "file" with a file' },
      400,
    );
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

  const rawText = await upstream.text();
  let payload: unknown;
  try {
    payload = rawText.length ? JSON.parse(rawText) : null;
  } catch (parseErr) {
    const snippet =
      rawText.length > 500 ? `${rawText.slice(0, 500)}…` : rawText;
    console.error("[upload] Cloudinary: JSON parse алдаа", {
      httpStatus: upstream.status,
      parseError:
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      bodySnippet: snippet,
    });
    return c.json(
      {
        error: "Invalid JSON from Cloudinary",
        details: { upstreamHttpStatus: upstream.status, bodySnippet: snippet },
      },
      502,
    );
  }

  const obj = payload as Record<string, unknown> | null;

  if (!upstream.ok) {
    const err = obj?.["error"];
    const msg =
      err && typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : `HTTP ${upstream.status}`;
    const cloudinaryHttpCode =
      err && typeof err === "object" && err !== null && "http_code" in err
        ? Number((err as { http_code: unknown }).http_code)
        : undefined;

    console.error("[upload] Cloudinary upload амжилтгүй", {
      fetchHttpStatus: upstream.status,
      cloudinaryError: err,
      message: msg,
      cloudinaryHttpCode,
      responseKeys: obj && typeof obj === "object" ? Object.keys(obj) : [],
    });

    return c.json(
      {
        error: "Cloudinary upload failed",
        details: {
          message: msg,
          upstreamHttpStatus: upstream.status,
          ...(cloudinaryHttpCode !== undefined &&
          !Number.isNaN(cloudinaryHttpCode)
            ? { cloudinaryHttpCode }
            : {}),
        },
      },
      502,
    );
  }

  const secureUrl = obj?.["secure_url"];
  if (typeof secureUrl !== "string") {
    console.error("[upload] Cloudinary: secure_url алга", {
      upstreamHttpStatus: upstream.status,
      payload: obj,
    });
    return c.json(
      {
        error: "Unexpected Cloudinary response (no secure_url)",
        details: {
          keys: obj && typeof obj === "object" ? Object.keys(obj) : [],
        },
      },
      502,
    );
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

  const { storeId, name, price, description, images } = body as Record<
    string,
    unknown
  >;

  if (typeof storeId !== "string" || storeId.length === 0) {
    return c.json({ error: "storeId is required" }, 400);
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    !Number.isInteger(price) ||
    price < 0
  ) {
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
  if (
    typeof themeConfig !== "object" ||
    themeConfig === null ||
    Array.isArray(themeConfig)
  ) {
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

  const nextTheme = normalizeSiteThemeForDb(patch) as ThemeConfig;
  const themeBag = nextTheme as Record<string, unknown>;
  const shopLabel =
    typeof themeBag.shopName === "string" &&
    themeBag.shopName.trim().length > 0
      ? themeBag.shopName.trim()
      : store.name;
  const nextSlug = await allocateUniqueStoreSlug(
    db,
    shopLabel,
    storeId,
    store.slug,
  );

  await db
    .update(schema.stores)
    .set({ themeConfig: nextTheme, slug: nextSlug })
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
