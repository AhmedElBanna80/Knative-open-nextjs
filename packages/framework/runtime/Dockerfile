FROM node:18-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./ 
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY . .
# This assumes the user has already built the Next.js app locally or in CI
# COPY --from=deps /app/node_modules ./node_modules
# RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy the standalone build
# The user must copy their .next/standalone here
COPY --chown=nextjs:nodejs .next/standalone ./
COPY --chown=nextjs:nodejs .next/static ./.next/static
COPY --chown=nextjs:nodejs public ./public

# Copy the custom cache handler (compiled)
COPY --chown=nextjs:nodejs cache-handler.js ./cache-handler.js
COPY --chown=nextjs:nodejs runner.js ./runner.js

# Set environment variable to use the cache handler
# Note: The user's next.config.js must also be configured to read this or use it
# But since we can't easily modify next.config.js inside the image without re-building,
# we rely on the user configuring it or we wrap the server.
# For this MVP, we assume the user sets incrementalCacheHandlerPath in next.config.js 
# to require.resolve('./cache-handler.js')

USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "runner.js"]
