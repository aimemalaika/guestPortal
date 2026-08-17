# =============================================================================
# Multi-stage build for Omada Guest Portal
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build the application
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies for native modules (bcrypt)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source code
COPY tsconfig.json ./
COPY src ./src/
COPY views ./views/
COPY public ./public/

# Build TypeScript
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Production image
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

WORKDIR /app

# Install wget for healthcheck
RUN apk add --no-cache wget

# Create non-root user
RUN addgroup -g 1001 -S portal && \
    adduser -S portal -u 1001

# Copy package files and install production dependencies only
COPY package*.json ./
COPY prisma ./prisma/

# Install production dependencies and rebuild bcrypt for alpine
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    npx prisma generate && \
    apk del python3 make g++ && \
    rm -rf /root/.npm

# Copy built application from builder
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/views ./views/
COPY --from=builder /app/public ./public/

# Create data directory and set permissions
RUN mkdir -p /data && chown portal:portal /data

# Switch to non-root user
USER portal

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:8080/healthz || exit 1

# Start the application
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
