# Web Expansion and Auth Model

Authentication, public web surfaces, and admin access.

**Last updated:** 2026-04-02

---

## Authentication

- **Telegram-only** via HMAC `initData` validation
- Token expiry: **24 hours**
- Clock skew tolerance: **30 seconds**
- No Telegram Login widget
- No independent web session model (cookies, JWT refresh, etc.)

All authenticated routes require valid Telegram `initData`. There is no way to log in outside of the Telegram Mini App context.

## Public Web Surfaces

### Public API

- `GET /public/wishlists/:slug` — returns wishlist data without authentication

### SSR Share Pages

- `/w/[slug]` — server-rendered share page with dynamic OpenGraph metadata
- Used when wishlist links are shared outside Telegram (social previews, etc.)

### SEO

- No `robots.txt` configured
- No `sitemap.xml` generated

## Application Entry Points

| Path       | Purpose                        | Auth Required |
|------------|--------------------------------|---------------|
| `/miniapp` | Main Telegram Mini App entry   | Yes (initData) |
| `/w/[slug]`| Public share page (SSR)        | No             |
| `/admin`   | Admin panel                    | Yes (Basic Auth)|

## Admin Panel

- Path: `/admin`
- Auth: HTTP Basic Auth via `ADMIN_BASIC_USER` and `ADMIN_BASIC_PASS` env vars
- Separate from Telegram auth entirely

## Source Paths

- Auth middleware: `apps/api/src/` (Telegram initData validation)
- Share pages: `apps/web/app/w/`
- Admin: `apps/web/app/admin/`
- Public API: `apps/api/src/` (public routes)
