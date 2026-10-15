FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY api/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY api/server.js ./server.js
COPY web /app/web
ENV WEB_DIR=/app/web
EXPOSE 5000
CMD ["node","server.js"]
