import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  role: text("role", { enum: ["admin", "merchant"] }).notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  phone: text("phone"),
});

export type ThemeConfig = {
  colors?: Record<string, string>;
  logoUrl?: string;
  heroImageUrl?: string;
  /** ISO 4217 code stored for storefront / admin display. */
  currency?: string;
};

export const stores = sqliteTable("stores", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  themeConfig: text("theme_config", { mode: "json" })
    .$type<ThemeConfig>()
    .notNull()
    .default("{}"),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  storeId: text("store_id")
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  price: integer("price").notNull(),
  description: text("description"),
  images: text("images", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default("[]"),
  sku: text("sku").notNull().default(""),
  category: text("category").notNull().default(""),
  size: text("size").notNull().default(""),
  status: text("status", { enum: ["live", "draft"] })
    .notNull()
    .default("live"),
  inventory: integer("inventory").notNull().default(0),
  salesCount: integer("sales_count").notNull().default(0),
  revenue: integer("revenue").notNull().default(0),
});

export const storeCategories = sqliteTable(
  "store_categories",
  {
    storeId: text("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storeId, t.name] }),
  }),
);

export type CustomerInfo = {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
};

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  storeId: text("store_id")
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" }),
  customerInfo: text("customer_info", { mode: "json" })
    .$type<CustomerInfo>()
    .notNull(),
  totalPrice: integer("total_price").notNull(),
  status: text("status", {
    enum: ["pending", "paid", "processing", "shipped", "cancelled"],
  })
    .notNull()
    .default("pending"),
  createdAt: text("created_at").notNull(),
});
