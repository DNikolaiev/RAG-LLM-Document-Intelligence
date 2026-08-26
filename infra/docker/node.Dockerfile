FROM node:24.13.0-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
ARG PACKAGE
RUN pnpm install --frozen-lockfile && pnpm --filter "${PACKAGE}..." build

FROM node:24.13.0-alpine AS runtime
RUN addgroup -S caselens && adduser -S caselens -G caselens && corepack enable
WORKDIR /app
COPY --from=build --chown=caselens:caselens /app /app
ARG PACKAGE
ENV PACKAGE=${PACKAGE}
USER caselens
CMD ["sh", "-c", "pnpm --filter \"${PACKAGE}\" start"]
