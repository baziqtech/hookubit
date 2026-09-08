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
# Where the INGEST API lives - the host in the `curl` the get-started page hands
# a new operator (apps/dashboard/src/features/onboarding/publish-request.ts).
# Ingest is a SEPARATE service from the control API this dashboard talks to:
# Go on :8080 versus NestJS on :3000, a different host in every real
# deployment, and not derivable from the page's own origin. Vite inlines it at
# BUILD time exactly like VITE_API_TRANSPORT above, so it cannot be set by an
# env var, a ConfigMap or a Helm value on the running container. If it is
# wrong, it is wrong for the life of the image.
#
# The default is EMPTY, and empty means "do not pass it at all" (see the RUN
# line): the bundle then uses its own documented fallback of
# http://localhost:8080 and the get-started page prints that URL next to
# "Set VITE_INGEST_BASE_URL at build time if yours is elsewhere".
#
# Empty is NOT passed through as an empty string on purpose. `ingestBaseUrl()`
# is `import.meta.env.VITE_INGEST_BASE_URL ?? 'http://localhost:8080'`, and `??`
# only fires on undefined - exporting an empty value would inline `''`, defeat
# the fallback and produce a host-less `curl POST /v1/events` that fails in a
# way no operator can read. Unset behaves; empty does not.
#
# Set it for every deployment that is not a laptop:
#     docker build --build-arg VITE_INGEST_BASE_URL=https://ingest.example.com \
#       -f deployments/docker/dashboard.Dockerfile .
# The Helm chart cannot do this for you - see deployments/HANDOFF.md,
# "Dashboard build-time configuration".
ARG VITE_INGEST_BASE_URL=

# Both values are passed on the RUN line rather than via `ENV FOO=${FOO}`: a
# self-referential ENV is hadolint DL3044, and neither is needed after Vite has
# inlined it - the runtime stage is nginx serving static files, which reads no
# environment at all. `env` (not a bare prefix) so the `:+` guard can expand to
# nothing when VITE_INGEST_BASE_URL is unset; a prefix assignment produced by
# expansion would be parsed as the command name instead.
RUN echo "Building dashboard with VITE_API_TRANSPORT=${VITE_API_TRANSPORT} VITE_INGEST_BASE_URL=${VITE_INGEST_BASE_URL:-<unset: bundle falls back to http://localhost:8080>}" \
 && env VITE_API_TRANSPORT="${VITE_API_TRANSPORT}" \
        ${VITE_INGEST_BASE_URL:+VITE_INGEST_BASE_URL="${VITE_INGEST_BASE_URL}"} \
        pnpm --filter @webhook/dashboard build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html
COPY deployments/docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
