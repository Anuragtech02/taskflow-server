FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies (including devDependencies for drizzle-kit)
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx tsc

# Production
FROM base AS production
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./
COPY package.json start.sh ./

EXPOSE 9001
CMD ["sh", "start.sh"]
