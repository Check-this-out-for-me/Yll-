FROM node:20-bookworm-slim

ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  ca-certificates \
  fonts-liberation \
  fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev
COPY server.js .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
EXPOSE 8787
CMD ["npm", "start"]