# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter @webhook/dashboard...
COPY apps/dashboard/ apps/dashboard/
RUN pnpm --filter @webhook/dashboard build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html
COPY deployments/docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
