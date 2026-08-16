# syntax=docker/dockerfile:1

# --- Etap build: kompilacja TypeScript -> dist ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Etap runtime (produkcja): tylko dist + zaleznosci produkcyjne ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    LOG_TO_FILE=false
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && mkdir -p /app/data \
    && chown node:node /app/data
COPY --from=build --chown=node:node /app/dist ./dist
# Uruchamiamy jako uzytkownik nieuprzywilejowany (obraz node ma usera "node")
USER node
EXPOSE 3000
# Healthcheck oparty o wbudowany fetch (Node 22) - bez dodatkowych zaleznosci
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

# --- Etap dev: hot-reload (tsx watch) do lokalnej pracy ---
FROM node:22-alpine AS dev
WORKDIR /app
ENV NODE_ENV=development \
    PORT=3000
COPY package*.json ./
RUN npm ci
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["npm", "run", "dev"]
