# Aishwarya — Almara by Aishwarya

Netlify-ready luxury saree storefront + protected admin foundation.

## Netlify architecture

Browser
→ Netlify static site (`public/`)
→ Netlify Function (`netlify/functions/api.mjs`)
→ Express API (`server/server.js`)
→ PostgreSQL

The admin is available at `/admin/`.

## Deploy

1. Push this folder to GitHub.
2. In Netlify, choose **Add new project → Import an existing project** and select the GitHub repository.
3. Netlify will read `netlify.toml`: publish directory is `public`, and Functions are in `netlify/functions`.
4. Set the production environment variables in **Project configuration → Environment variables**. Do not commit `.env` or secrets.
5. Deploy.
6. Run the PostgreSQL statements in `server/schema.sql` against your production database.
7. Open `https://YOUR-SITE.netlify.app/` for the storefront and `/admin/` for the admin area.

## Required production variables

DATABASE_URL
JWT_SECRET
COOKIE_SECURE=true
CORS_ORIGIN=https://YOUR-SITE.netlify.app
OTP_PROVIDER=<production provider>
RAZORPAY_KEY_ID=<when payment integration is connected>
RAZORPAY_KEY_SECRET=<when payment integration is connected>
DELHIVERY_API_TOKEN=<when Delhivery integration is connected>
DELHIVERY_BASE_URL=https://track.delhivery.com

Netlify Functions can read function-scoped environment variables at runtime. Set secrets in Netlify's UI/CLI rather than committing them.

## Current state

Implemented foundation:
- Luxury storefront based on the supplied design
- Aishwarya branding
- Instagram + WhatsApp contact details
- PostgreSQL schema
- Customer password authentication
- OTP challenge foundation
- Owner/staff role authorization
- TOTP support for privileged accounts
- Admin overview/orders/products/analytics views
- Audit logs
- First-party analytics events
- Netlify Functions adapter

Still required before accepting real money/orders:
- Production OTP provider
- Payment gateway + verified webhooks
- Cloud image storage and signed uploads
- Delhivery production shipment/tracking adapter
- Full checkout/cart UI and order creation workflow
- Production database/backup/monitoring setup
- Security review and end-to-end testing

Never put payment card data, database passwords, OTP secrets, or JWT secrets in browser code.
