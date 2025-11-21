FROM node:18-alpine

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install ALL dependencies (including dev) for build
RUN npm install

# Copy application code
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build the application
RUN npm run build

# Set environment to production
ENV NODE_ENV=production

EXPOSE 3000

# Start command: run migrations and start server
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
