# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter @webhook/dashboard...
COPY apps/dashboard/ apps/dashboard/

# Which API the bundle talks to. Vite inlines this at BUILD time, so it cannot
# be changed by an env var on the running container - the value baked in here
# is the value the image will always have.
#
# The default is DELIBERATELY `mock`, not an oversight: the control API today
# exposes only auth, health, organizations, members, projects, api-keys,
# endpoints and endpoint-secrets, so a large part of the dashboard (events,
# deliveries, attempts, subscriptions, replay) would 404 against it. An image
# built with `http` right now would be broken in a way that looks like an
# outage rather than an unfinished feature.
#
# The mock build is not silent about itself: src/components/DemoDataBanner.tsx
# renders a non-dismissible "Demo data - not connected to an API" bar whenever
# `usingMockApi` is true, on every page including the auth pages.
#
# ═══ FLIP THIS TO `http` WHEN THE CONTROL API IS FEATURE-COMPLETE. ═══
# It is one line, here, and nothing else has to change:
#     ARG VITE_API_TRANSPORT=http
# or, without editing the file:
#     docker build --build-arg VITE_API_TRANSPORT=http \
#       -f deployments/docker/dashboard.Dockerfile .
# See deployments/HANDOFF.md, "Dashboard transport".
ARG VITE_API_TRANSPORT=mock
# Passed on the RUN line rather than via `ENV VITE_API_TRANSPORT=${VITE_API_TRANSPORT}`:
# a self-referential ENV is hadolint DL3044, and the value is only needed for
# the duration of this build - Vite has already inlined it into the bundle by
# the time the layer is written, and the runtime stage is nginx serving static
# files, which reads no environment at all.
RUN echo "Building dashboard with VITE_API_TRANSPORT=${VITE_API_TRANSPORT}" \
 && VITE_API_TRANSPORT="${VITE_API_TRANSPORT}" pnpm --filter @webhook/dashboard build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html
COPY deployments/docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
