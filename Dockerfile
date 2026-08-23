FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts=false

COPY src ./src

RUN mkdir -p /app/data \
  && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
