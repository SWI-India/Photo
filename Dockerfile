FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /tmp/swi-field-reports-uploads /data \
  && chown -R node:node /app /tmp/swi-field-reports-uploads /data

USER node

CMD ["npm", "start"]
