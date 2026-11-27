FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --allow-build=argon2 --allow-build=bufferutil --allow-build=utf-8-validate --allow-build=esbuild
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/web apps/web
COPY agent agent
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter api build && pnpm --filter web build

FROM node:24-bookworm-slim AS runtime
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --prod --filter api... --allow-build=argon2 --allow-build=bufferutil --allow-build=utf-8-validate --allow-build=esbuild || pnpm install --frozen-lockfile --allow-build=argon2 --allow-build=bufferutil --allow-build=utf-8-validate --allow-build=esbuild --allow-build=argon2 --allow-build=bufferutil --allow-build=utf-8-validate --allow-build=esbuild
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/agent agent
RUN mkdir -p /data
EXPOSE 8080
ENV PORT=8080 SERVE_WEB=true WEB_DIST=/app/apps/web/dist DATABASE_PATH=/data/app.sqlite
CMD ["node", "apps/api/dist/index.js"]
