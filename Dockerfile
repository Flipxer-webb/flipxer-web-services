FROM node:18.18.2 as build
WORKDIR /usr/src/app
RUN npm install -g pnpm
COPY ./package.json .
RUN pnpm install
COPY . .
RUN pnpm prisma generate 
RUN pnpm build

FROM node:18.18.2 as production
ENV TZ=Africa/Lagos
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN npm install -g pnpm
COPY ./package.json .
COPY ./public ./public
COPY ./prisma ./prisma
RUN pnpm install --prod
RUN pnpm prisma generate 
COPY --from=build /usr/src/app/dist ./dist
CMD ["node", "dist/server"]


 


 