import { defineConfig } from "drizzle-kit";

/**
 * `drizzle-kit generate`: зөвхөн schema + SQLite диалект хангалттай.
 * Migration-уудыг Cloudflare дээр: app-ийн wrangler-аар `d1 migrations apply`.
 * Remote руу шууд push (turbo iterate): d1-http + .env — https://orm.drizzle.team/docs/get-started/d1-new
 */
export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
