# Checkout & Rewards Service

Backend for an ecommerce store: carts, checkout, orders, and milestone-based coupons.
Node.js + TypeScript, Fastify, PostgreSQL 16 (hand-written SQL via `pg`), Vitest.

## Setup

Prerequisites: Node.js 20+, Docker (with compose).

```sh
npm install
cp .env.example .env        # defaults work as-is
npm run db:up               # Postgres 16 on localhost:5433 (dev DB `checkout`, test DB `checkout_test`)
npm run db:reset            # drop schema, migrate, seed the dev DB
npm run dev                 # http://localhost:3000
curl localhost:3000/health  # {"status":"ok"}
```

## Tests

```sh
npm run typecheck
npm test                    # runs against TEST_DATABASE_URL, resets it first
```
