# apptrigger API for Cloud Run.
# Node 24 is the current long-term-support release (22 is the oldest still supported). The tag follows the newest 24.x
# patch each time the image is built.
FROM node:24-alpine

# Pick up the operating system's latest security fixes on top of what the base image shipped with.
RUN apk upgrade --no-cache

WORKDIR /app

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Application code and the default config (used when GITHUB_REPO is not set).
COPY src/ ./src/
COPY config.example.json ./

# Cloud Run injects PORT (8080) at runtime. src/server.js reads process.env.PORT.
ENV NODE_ENV=production
# This API has no sign-in; inside a container it must listen on every address (otherwise only on localhost).
ENV HOST=0.0.0.0
EXPOSE 8080

# Run as the unprivileged user that comes with the image.
USER node

# No --env-file here: settings come from Cloud Run environment variables.
CMD ["node", "src/server.js"]
