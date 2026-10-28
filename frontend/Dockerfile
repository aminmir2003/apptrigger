# apptrigger web page for Cloud Run: built with Vite, served by nginx.

# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Address of the backend API, baked into the page at build time (see src/api.js).
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─── Stage 2: serve with nginx ────────────────────────────────────────────────
FROM nginx:stable-alpine

# Pick up the operating system's latest security fixes on top of what the base image shipped with.
RUN apk upgrade --no-cache

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

# Cloud Run sends traffic to port 8080.
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
