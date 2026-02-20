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

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/data/wiki ./data/wiki
RUN mkdir -p /app/data && chown -R node:node /app/data /app

# Runtime runs as non-root; writable /app/data keeps wiki edits functional.
USER node

EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/index.js"]
