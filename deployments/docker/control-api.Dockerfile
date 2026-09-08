# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
WORKDIR /app

# WHY openssl IS INSTALLED (and why it must be in the runtime stage too):
#
# Prisma picks its query engine by probing for libssl. node:22-alpine ships no
# openssl at all, so 5.22 logs
#   "Prisma failed to detect the libssl/openssl version to use ...
#    Defaulting to openssl-1.1.x"
# and downloads/copies libquery_engine-linux-musl.so.node - the OpenSSL 1.1
# build. Alpine has only OpenSSL 3, so that .so cannot be dlopen'd and the
# `node --eval` guard below dies with
#   "Unable to require(.../.prisma/client/libquery_engine-linux-musl.so.node)".
# The engine was not missing; it was the wrong one.
#
# Installing openssl makes detection return linux-musl-openssl-3.0.x, and it
# must be installed BEFORE `pnpm install` so @prisma/engines' postinstall
# downloads that engine rather than the 1.1 one. The runtime stage installs it
# as well, so the engine that gets generated is the engine that gets loaded -
# the two stages must agree, or this comes back in production instead of here.
#
# The durable belt-and-braces is one line in a file this Dockerfile does not
# own: `binaryTargets` in apps/control-api/prisma/schema.prisma. See
# deployments/HANDOFF.md, "Prisma engine binary targets".
#
# hadolint ignore=DL3018
RUN apk add --no-cache openssl \
 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-api/package.json apps/control-api/
RUN pnpm install --frozen-lockfile --filter @webhook/control-api...
COPY apps/control-api/ apps/control-api/

# WHY THE SECOND `prisma generate`:
#
# `pnpm deploy` does not copy the workspace's node_modules. It rebuilds the tree
# by re-linking packages out of the content-addressable store. The Prisma client
# is GENERATED code written into the virtual store
# (node_modules/.pnpm/@prisma+client@<v>_prisma@<v>/node_modules/.prisma/client)
# - it is not store content, so it is not carried across. `--prod` then strips
# the `prisma` CLI (it is a devDependency of apps/control-api), so nothing in the
# deploy tree can regenerate it either.
#
# The result, if you skip the second generate: `require('@prisma/client')` throws
# `Cannot find module '.prisma/client/default'`. PrismaService extends
# PrismaClient and is constructed during Nest module init, so `node dist/main.js`
# dies before app.listen and every pod CrashLoopBackOffs - with maxUnavailable: 0
# the rollout then never completes. Verified by building the deploy tree with
# pnpm and requiring the client.
#
# The builder still has the CLI, and `prisma generate --schema` resolves its
# default output through the @prisma/client it finds from the schema's
# directory - so pointing it at /app/deploy/prisma/schema.prisma writes the
# client into the DEPLOY tree's virtual store, which is what the runtime stage
# copies. The `node --eval` below is the regression guard: if the generated
# client is ever missing again, the image fails to build instead of failing in
# production.
#
# The permanent fix is one line in a file this Dockerfile does not own: move
# `prisma` from devDependencies to dependencies in apps/control-api/package.json.
# See deployments/HANDOFF.md.
RUN pnpm --filter @webhook/control-api prisma:generate \
 && pnpm --filter @webhook/control-api build \
 && pnpm deploy --filter @webhook/control-api --prod /app/deploy \
 && pnpm --filter @webhook/control-api exec prisma generate --schema=/app/deploy/prisma/schema.prisma \
 && node --eval "const {PrismaClient} = require('/app/deploy/node_modules/@prisma/client'); new PrismaClient(); console.log('prisma client present in deploy tree');"

# Migration image (ARCHITECTURE.md 41). Kept BEFORE the runtime stage so that a
# plain `docker build` still produces the runtime image by default.
#
# The runtime stage below is pruned to production dependencies and the Prisma
# CLI is a devDependency, so it cannot run `prisma migrate deploy` without
# fetching the CLI from npm at run time. This stage keeps the full builder
# tree instead. It is larger and is run once per deploy, not served.
#
# `--no-install` so npx can never silently fetch `prisma@latest` from the
# registry and apply a history authored by 5.22 with whatever major shipped this
# morning. If the CLI is missing, fail loudly.
FROM builder AS migrate
WORKDIR /app/apps/control-api
USER node
CMD ["npx", "--no-install", "prisma", "migrate", "deploy"]

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Same reason as the builder stage: without openssl, Prisma's runtime detection
# falls back to openssl-1.1.x and looks for an engine that was never generated.
# hadolint ignore=DL3018
RUN apk add --no-cache openssl
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/apps/control-api/dist ./dist
COPY --from=builder /app/apps/control-api/prisma ./prisma
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
