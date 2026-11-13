FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV NODE_ENV=production PORT=8080 TLS_PORT=8443
EXPOSE 8080 8443
CMD ["node", "server.js"]
