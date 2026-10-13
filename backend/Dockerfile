# apptrigger API for Cloud Run.
FROM node:22-alpine

WORKDIR /app

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Application code, the default config (used when GITHUB_REPO is not set) and the team sheet.
# CMDBID.xlsx is kept out of git: the deploy workflow writes it into backend/ before building.
COPY src/ ./src/
COPY config.example.json CMDBID.xlsx ./

# Cloud Run injects PORT (8080) at runtime. src/server.js reads process.env.PORT.
ENV NODE_ENV=production
EXPOSE 8080

# Run as the unprivileged user that comes with the image.
USER node

# No --env-file here: settings come from Cloud Run environment variables.
CMD ["node", "src/server.js"]
