FROM node:20-alpine

WORKDIR /app

# Build tools for better-sqlite3's native addon (compiled at install time).
RUN apk add --no-cache python3 make g++

# Install dependencies (including dev deps needed to compile TypeScript)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Prune dev dependencies to slim the runtime image (keeps the compiled sqlite addon)
RUN npm prune --omit=dev

ENV NODE_ENV=production
# SQLite database location (mount a Render disk here for cross-deploy persistence)
ENV SQLITE_PATH=/app/data/taxipro.db
EXPOSE 10000

CMD ["node", "dist/index.js"]
