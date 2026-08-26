FROM node:24.13.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
ARG PACKAGE
RUN npm ci && npm run build

FROM node:24.13.0-alpine AS runtime
RUN addgroup -S caselens && adduser -S caselens -G caselens
WORKDIR /app
COPY --from=build --chown=caselens:caselens /app /app
ARG PACKAGE
ENV PACKAGE=${PACKAGE}
USER caselens
CMD ["sh", "-c", "npm run start --workspace=\"${PACKAGE}\""]
