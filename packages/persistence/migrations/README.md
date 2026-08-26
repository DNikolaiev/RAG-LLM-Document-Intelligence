# Persistence migrations

`src/schema.ts` is the typed table source. Run the package's configured Drizzle generation command through npm (for example, `npm run db:generate --workspace=@caselens/persistence`) to write the ordinary table DDL under `migrations/generated`, review it, then run `9999_post_drizzle.sql` after those generated files to add PostgreSQL-specific vector/full-text/partial indexes, RLS, and grants.

The local container profile uses the equivalent, reviewed scripts in `infra/postgres/init` in lexical order: roles/extensions, tables/indexes, then RLS/grants. Production environments should apply the generated and post-Drizzle migrations through a dedicated migration role rather than relying on container initialization.
