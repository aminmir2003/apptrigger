# apptrigger API for Cloud Run.
FROM node:22-alpine

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
