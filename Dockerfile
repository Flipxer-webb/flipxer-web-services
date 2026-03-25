# ---- Development Stage ----
FROM node:18.18.2 AS dev
WORKDIR /usr/src/app
RUN npm install -g pnpm
COPY ./package.json ./pnpm-lock.yaml ./
RUN pnpm install
COPY ./prisma ./prisma
RUN pnpm prisma generate
COPY . .
EXPOSE 3500
CMD ["sh", "-c", "pnpm build && node dist/server"]

# ---- Build Stage ----
FROM node:18.18.2 AS build
WORKDIR /usr/src/app
RUN npm install -g pnpm
COPY ./package.json ./pnpm-lock.yaml ./
RUN pnpm install
COPY . .
RUN pnpm prisma generate
RUN pnpm build

# ---- Production Stage ----
FROM node:18.18.2 AS production
ENV TZ=Africa/Lagos
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN npm install -g pnpm
# SECURITY: Create non-root user
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nestjs
COPY ./package.json .
COPY ./tsconfig.json .
COPY ./public ./public
COPY ./prisma ./prisma
RUN pnpm install --prod
RUN pnpm add -D ts-node typescript @types/node
RUN pnpm prisma generate
COPY --from=build /usr/src/app/dist ./dist
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh
# SECURITY: Switch to non-root user
USER nestjs
CMD ["./docker-entrypoint.sh"]
