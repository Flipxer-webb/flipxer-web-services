# ---- Development Stage ----
FROM node:20 AS dev
WORKDIR /usr/src/app
RUN apt-get update && \
    apt-get install -y --no-install-recommends poppler-utils && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY ./package.json ./pnpm-lock.yaml ./.npmrc ./.pnpmfile.cjs ./
RUN --mount=type=cache,id=pnpm-web-services,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY ./prisma ./prisma
RUN pnpm prisma generate
COPY ./src ./src
COPY ./tsconfig.json ./tsconfig.build.json ./nest-cli.json ./webpack.config.js ./
COPY ./email-templates ./email-templates
COPY ./public ./public
COPY ./scripts ./scripts
COPY docker-entrypoint.dev.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.dev.sh && chmod +x docker-entrypoint.dev.sh
EXPOSE 3500
CMD ["./docker-entrypoint.dev.sh"]

# ---- Build Stage ----
FROM node:20 AS build
WORKDIR /usr/src/app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY ./package.json ./pnpm-lock.yaml ./.npmrc ./.pnpmfile.cjs ./
RUN --mount=type=cache,id=pnpm-web-services,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY ./prisma ./prisma
COPY ./src ./src
COPY ./tsconfig.json ./tsconfig.build.json ./nest-cli.json ./webpack.config.js ./
COPY ./email-templates ./email-templates
COPY ./public ./public
RUN pnpm prisma generate
RUN NODE_OPTIONS=--experimental-global-webcrypto pnpm build

# ---- Production Stage ----
FROM node:20 AS production
ENV TZ=Africa/Lagos
WORKDIR /usr/src/app
RUN apt-get update && \
    apt-get install -y --no-install-recommends poppler-utils && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable && corepack prepare pnpm@9.15.9 --activate && \
    groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nestjs
COPY ./package.json ./pnpm-lock.yaml ./.npmrc ./.pnpmfile.cjs ./
COPY ./tsconfig.json .
COPY ./public ./public
COPY ./prisma ./prisma
# Install ALL deps (including devDeps) so ts-node is available for prisma db seed.
# NODE_ENV=production is set AFTER install to prevent pnpm from skipping devDependencies.
RUN --mount=type=cache,id=pnpm-web-services,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm prisma generate
ENV NODE_ENV=production
COPY --from=build /usr/src/app/dist ./dist
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh
# SECURITY: Switch to non-root user
USER nestjs
CMD ["./docker-entrypoint.sh"]
