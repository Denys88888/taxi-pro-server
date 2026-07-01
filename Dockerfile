FROM node:20-alpine

WORKDIR /app

# Install dependencies (including dev deps needed to compile TypeScript)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Prune dev dependencies to slim the runtime image
RUN npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "dist/index.js"]
