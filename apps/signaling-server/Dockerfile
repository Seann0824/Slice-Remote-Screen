FROM node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile

ARG VITE_SIGNALING_SERVER=
ENV VITE_SIGNALING_SERVER=${VITE_SIGNALING_SERVER}
RUN pnpm build:signaling

FROM node:22-bookworm-slim

WORKDIR /app
RUN corepack enable
COPY --from=build /workspace /app
ENV NODE_ENV=production
ENV SIGNALING_HOST=0.0.0.0
ENV SIGNALING_PORT=8787
ENV SIGNALING_DATA_FILE=/data/device.json
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "apps/signaling-server/dist/server.js"]
