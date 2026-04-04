# ---- Development Stage ----
FROM node:18.18.2 AS dev
WORKDIR /usr/src/app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY ./package.json ./pnpm-lock.yaml ./.npmrc ./.pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY ./prisma ./prisma
RUN pnpm prisma generate
COPY ./src ./src
COPY ./tsconfig.json ./tsconfig.build.json ./nest-cli.json ./webpack.config.js ./
COPY ./email-templates ./email-templates
COPY ./public ./public
COPY ./scripts ./scripts
EXPOSE 3500
CMD ["sh", "-c", "NODE_OPTIONS=--experimental-global-webcrypto pnpm build && node dist/server"]

# ---- Build Stage ----
FROM node:18.18.2 AS build
WORKDIR /usr/src/app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY ./package.json ./pnpm-lock.yaml ./.npmrc ./.pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY ./prisma ./prisma
COPY ./src ./src
COPY ./tsconfig.json ./tsconfig.build.json ./nest-cli.json ./webpack.config.js ./
COPY ./email-templates ./email-templates
COPY ./public ./public
RUN pnpm prisma generate
RUN NODE_OPTIONS=--experimental-global-webcrypto pnpm build

# ---- Production Stage ----
FROM node:18.18.2 AS production
ENV TZ=Africa/Lagos
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && \
    groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nestjs
COPY ./package.json ./pnpm-lock.yaml ./.npmrc ./.pnpmfile.cjs ./
COPY ./tsconfig.json .
COPY ./public ./public
COPY ./prisma ./prisma
RUN pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm prisma generate
COPY --from=build /usr/src/app/dist ./dist
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh
# SECURITY: Switch to non-root user
USER nestjs
CMD ["./docker-entrypoint.sh"]
