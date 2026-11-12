# Una sola imagen para la API, el worker y las migraciones.
# La API también sirve el frontend compilado.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Solo las dependencias de producción de la API.
RUN pnpm --filter @icmspy/api deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3020 \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/web/dist ./web
COPY --from=build /app/packages/db/migrations ./migrations
USER node
EXPOSE 3020
CMD ["node", "dist/main.js"]
