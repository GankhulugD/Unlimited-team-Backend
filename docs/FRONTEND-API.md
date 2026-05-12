# Frontend-д зориулсан API тэмдэглэл

Доорх баримт нь **JSON** / **multipart** хэлбэртэй хүсэлт, **албан бус** жишээ (`fetch`) агуулна. API-ийн бодит домэйнг өөрсдийн орчинд (`localhost`, Cloudflare Workers URL гэх мэт) тохируулна.

## Ерөнхий

| Зүйл | Утга |
|------|------|
| **Platform API** | Жишээ: `https://<platform-worker-хаяг>` — бүртгэл, дэлгүүр үүсгэх, админ (хэрэглэгч/дэлгүүр) |
| **Merchant API** | Жишээ: `https://<merchant-worker-хаяг>` — вэб дэлгүүр хуудсанд зориулсан өгөгдөл, бараа, захиалга, зураг upload |
| **CORS** | `origin: *`. Зөвшөөрөгдсөн method: `GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS`. Зөвшөөрөгдсөн header: `Content-Type`, `Authorization` |
| **Энгийн JSON POST/PATCH** | `Content-Type: application/json` заавал |

Алдаанууд ихэвчлэн `{ "error": "тайлбар текст" }` хэлбэртэй; зарим endpoint нь `details` талбар нэмж болно (жишээ нь Cloudinary алдаа).

**Анхаар:** Одоогийн кодод JWT/session шалгалт **байхгүй**. `/admin/*` замууд ч нээнэ — production-д backend-д authentication нэмэх эсвэл админ UI-г хамгаалах хэрэгтэй. `/admin/merchants` хариу нь `password` (hash) агуулж болно — шууд UI-д бүү харуул.

---

## Platform API

### `GET /`

Сервис амьд эсэх.

**Жишээ:**

```http
GET /
```

**Амжилт (200):**

```json
{ "service": "platform-api" }
```

---

### `POST /auth/register`

Шинэ хэрэглэгч үүсгэнэ. `admin` эрхээр энэ замаар бүртгүүлэхийг **зөвшөөрөхгүй** (403).

**Body (JSON):**

| Талбар | Төрөл | Заавал | Тайлбар |
|--------|--------|--------|---------|
| `email` | string | тийм | И-мэйл хаяг |
| `password` | string | тийм | Хамгийн багадаа 8 тэмдэгт |
| `role` | `"merchant"` \| `"admin"` | үгүй | Өгөөгүй бол `merchant`. `admin` өгвөл 403 |

**Жишээ:**

```js
await fetch(`${PLATFORM_BASE}/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "merchant@example.com",
    password: "supersecret",
    role: "merchant",
  }),
});
```

**Амжилт (201):**

```json
{
  "id": "uuid",
  "email": "merchant@example.com",
  "role": "merchant"
}
```

**Түргэн алдаа:** 400 (байгуулалт буруу), 403 (`admin` түвшинг энд үүсгэхгүй), 409 (и-мэйл аль хэдийн бүртгэлтэй).

---

### `POST /stores`

Дэлгүүр үүсгэнэ. `ownerId` нь **огноотой** `users.id` байх ёстой.

**Body (JSON):**

| Талбар | Төрөл | Заавал | Тайлбар |
|--------|--------|--------|---------|
| `ownerId` | string (UUID) | тийм | Эзэмшигч хэрэглэгч |
| `name` | string | тийм | Дэлгүүрийн нэр |
| `slug` | string | тийм | URL-д хэрэглэнэ; сервер руу илгээхэд ямар ч хэлбэрээр байж болно — **жижиг үсэг, зай → `-`, зөвшөөрөгдөхгүй тэмдэг арилгана** |
| `themeConfig` | object | үгүй | Өнгө, лого гэх мэт JSON объект (доор жишээ) |

`themeConfig` жишээ (бүтэн биш — хэрэгцээгээр нэмнэ):

```json
{
  "colors": { "primary": "#111827", "background": "#ffffff" },
  "logoUrl": "https://...",
  "heroImageUrl": "https://..."
}
```

**Жишээ:**

```js
await fetch(`${PLATFORM_BASE}/stores`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    ownerId: "550e8400-e29b-41d4-a716-446655440000",
    name: "Minii delguur",
    slug: "Minii Delguur!",
    themeConfig: { colors: { primary: "#000000" } },
  }),
});
```

**Амжилт (201):** Дэлгүүрийн бүртгэл (нэг мөр) — `id`, `ownerId`, `name`, `slug`, `themeConfig` гэх мэт.

**Түргэн алдаа:** 400 (талбар дутуу / slug хоосон болсон), 404 (`ownerId` олдсонгүй), 409 (`slug` давхардасан).

---

### `GET /admin/merchants` (Админ)

Бүх хэрэглэгч (`users`) — **нууц үгийн hash орно**.

**Жишээ:**

```js
const res = await fetch(`${PLATFORM_BASE}/admin/merchants`);
const users = await res.json();
// users: массив — элемент бүр: id, email, password, role
```

**Амжилт (200):** `User[]` (массив).

---

### `GET /admin/stores` (Админ)

Бүх дэлгүүр.

**Жишээ:**

```js
const res = await fetch(`${PLATFORM_BASE}/admin/stores`);
const stores = await res.json();
```

**Амжилт (200):** `Store[]`.

---

## Merchant API

### `GET /`

Сервис амьд эсэх.

**Амжилт (200):** `{ "service": "merchant-api" }`

---

### `POST /upload`

Зургийг **Cloudinary**-руу дамжуулан оруулна. Body нь **multipart/form-data**.

| Талбар | Төрөл | Заавал |
|--------|--------|--------|
| `file` | файл | тийм — `FormData`-д ингэж нэрлэнэ |

Хэмжээний дээд хязгаар: **5 MiB**.

**Жишээ:**

```js
const form = new FormData();
form.append("file", fileInput.files[0]);

const res = await fetch(`${MERCHANT_BASE}/upload`, {
  method: "POST",
  body: form,
});
const data = await res.json();
// data.secure_url — барааны images массивад хадгалах URL
```

**Амжилт (200):**

```json
{ "secure_url": "https://res.cloudinary.com/..." }
```

**Түргэн алдаа:** 400 (файл байхгүй), 413 (хэмжээ их), 503 (Cloudinary тохируулаагүй), 502 (Upstream алдаа).

---

### `GET /storefront/:slug`

Нэг дэлгүүрийн нийцсэн (public) өгөгдөл: дэлгүүр + тухайн дэлгүүрт харьяалагдах бүх бараа.

- `:slug` — URL-д `:slug` орно (жишээ нь `minii-delguur`). Сервер ижил `normalize` логик ашигладаг.

**Жишээ:**

```js
const slug = "minii-delguur";
const res = await fetch(`${MERCHANT_BASE}/storefront/${encodeURIComponent(slug)}`);
const data = await res.json();
```

**Амжилт (200):**

```json
{
  "store": {
    "id": "…",
    "name": "…",
    "slug": "…",
    "themeConfig": {}
  },
  "products": [
    {
      "id": "…",
      "storeId": "…",
      "name": "…",
      "price": 19900,
      "description": null,
      "images": ["https://..."]
    }
  ]
}
```

`price` нь **бүхэл тоо** (жишээ нь төгрөгийн дүн).

**Түргэн алдаа:** 400 (slug буруу), 404 (дэлгүүр олдсонгүй).

---

### `POST /products`

Шинэ бараа нэмнэ.

**Body (JSON):**

| Талбар | Төрөл | Заавал | Тайлбар |
|--------|--------|--------|---------|
| `storeId` | string | тийм | Дэлгүүрийн `id` |
| `name` | string | тийм | |
| `price` | number | тийм | **Бүхэл тоо**, ≥ 0 |
| `description` | string \| null | үгүй | Өгөөгүй бол сервер `null` болгоно |
| `images` | string[] | тийм | Ихэвчлэн Cloudinary `secure_url`-ууд |

**Жишээ:**

```js
await fetch(`${MERCHANT_BASE}/products`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    storeId: "…",
    name: "Уут",
    price: 15000,
    description: "Жижиг уут",
    images: ["https://res.cloudinary.com/.../image.jpg"],
  }),
});
```

**Амжилт (201):** Үүссэн `product` объект.

**Түргэн алдаа:** 400 (validation), 404 (`storeId` дэлгүүр байхгүй).

---

### `PATCH /stores/:id/theme`

Дэлгүүрийн `themeConfig`-ийг **хэсэгчлэн шинэчилнэ** (гүн нэгтгэлтэй merge: `colors` доторх түлхүүрүүд нэгдэнэ).

- `:id` — дэлгүүрийн UUID.

**Body (JSON):**

```json
{
  "themeConfig": {
    "colors": { "primary": "#1d4ed8" },
    "logoUrl": "https://..."
  }
}
```

**Жишээ:**

```js
const storeId = "…";
await fetch(`${MERCHANT_BASE}/stores/${storeId}/theme`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    themeConfig: { logoUrl: "https://example.com/logo.png" },
  }),
});
```

**Амжилт (200):** `id`, `ownerId`, `name`, `slug`, `themeConfig`.

**Түргэн алдаа:** 400, 404.

---

### `GET /orders/:storeId`

Тодорхой дэлгүүрийн бүх захиалгын жагсаалт.

**Амжилт (200):**

```json
{
  "items": [
    {
      "id": "…",
      "storeId": "…",
      "customerInfo": { "name": "…", "email": "…", "phone": "…", "address": "…" },
      "totalPrice": 50000,
      "status": "pending"
    }
  ]
}
```

`status` утгууд: `pending` | `paid` | `processing` | `shipped` | `cancelled`.

**Түргэн алдаа:** 400, 404 (дэлгүүр байхгүй).

---

### `GET /admin/products` (Админ)

Бүх дэлгүүрийн бүх бараа (массив).

```js
const products = await (await fetch(`${MERCHANT_BASE}/admin/products`)).json();
```

---

### `GET /admin/stats` (Админ)

Тоон статистик.

**Амжилт (200):**

```json
{
  "totalMerchants": 12,
  "totalStores": 8,
  "totalProducts": 240
}
```

`totalMerchants` нь `users` хүснэгтээс `role === "merchant"` тоог хэмжинэ.

---

## Өгөгдлийн загварууд (эзлэхүүн)

Эдгээр нь API-аас ирсэн объектуудын **логик** бүтэц (талбарын нэр JSON-д ихэвчлэн camelCase).

**User:** `id`, `email`, `password` (hash), `role` (`admin` | `merchant`)

**Store:** `id`, `ownerId`, `name`, `slug`, `themeConfig` (объект)

**Product:** `id`, `storeId`, `name`, `price` (бүхэл), `description` (string | null), `images` (string[])

**Order:** `id`, `storeId`, `customerInfo` (объект), `totalPrice` (бүхэл), `status`

---

## Алдааг frontend дээр боловсруулах

1. `response.ok` эсвэл `response.status` шалгах.
2. Алдааны хариу ихэвчлэн `const { error, details } = await response.json()`.
3. Сүлжээний алдаа (`fetch` reject) тусад нь try/catch.

---

## Хувьсагчийн жишээ (Vite / Next гэх мэт)

```env
VITE_PLATFORM_API_URL=https://platform.example.com
VITE_MERCHANT_API_URL=https://merchant.example.com
```

```js
const PLATFORM_BASE = import.meta.env.VITE_PLATFORM_API_URL;
const MERCHANT_BASE = import.meta.env.VITE_MERCHANT_API_URL;
```

Хөгжүүлэлтийн үед Workers `wrangler dev`-ийн хэвлэсэн хоёр өөр `localhost` порт ашиглаж болно — platform болон merchant тус тусдаа URL-тэй.
