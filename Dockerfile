# Single deployable image: the API serves the built web app.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps apps
RUN npm run build -w apps/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root --no-audit --no-fund
COPY apps/server apps/server
COPY seed seed
COPY --from=build /app/apps/web/dist apps/web/dist
EXPOSE 8080
USER node
CMD ["npx", "tsx", "apps/server/src/index.ts"]
