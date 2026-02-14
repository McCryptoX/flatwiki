FROM node:20-alpine AS build
WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY public ./public
COPY data/wiki ./data/wiki
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/data/wiki ./data/wiki

EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/index.js"]
