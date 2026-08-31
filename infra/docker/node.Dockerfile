FROM node:24.13.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY fixtures ./fixtures
ARG PACKAGE
ARG APP_MODE
ARG AUTH_MODE
ARG ENABLE_TEST_IDENTITY_SWITCHER
ARG PUBLIC_API_URL
ENV APP_MODE=${APP_MODE}
ENV AUTH_MODE=${AUTH_MODE}
ENV ENABLE_TEST_IDENTITY_SWITCHER=${ENABLE_TEST_IDENTITY_SWITCHER}
ENV PUBLIC_API_URL=${PUBLIC_API_URL}
RUN npm ci && npm run build

FROM node:24.13.0-alpine AS runtime
RUN addgroup -S caselens && adduser -S caselens -G caselens
WORKDIR /app
COPY --from=build --chown=caselens:caselens /app /app
ARG PACKAGE
ENV PACKAGE=${PACKAGE}
USER caselens
CMD ["sh", "-c", "npm run start --workspace=\"${PACKAGE}\""]
