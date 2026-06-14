# syntax=docker/dockerfile:1.7
# Two-stage build for the Ponder 0.16 indexer on Fly.io. The build context is
# this `indexer/` directory only (it is a pnpm-workspace member locally, but
# the image is standalone — no workspace root is copied in), so a plain
# npm install against this package.json resolves the full dependency tree.

FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
# Copy only the manifest first so this layer caches across code changes.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Ponder serves its HTTP API (GraphQL) on 42069 by default; fly.toml exposes
# 42069 internally.
ENV PORT=42069

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Persist the DB across deploys via a Fly volume mounted at /data.
ENV PONDER_DATABASE_URL=file:/data/ponder.db
RUN mkdir -p /data

EXPOSE 42069

# `ponder start` runs the indexer + HTTP API in production mode (no hot-reload,
# no codegen). `ponder serve` would serve the API only — we want both.
CMD ["npx", "ponder", "start"]
