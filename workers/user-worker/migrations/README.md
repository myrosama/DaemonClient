# Database Migrations

## Version Format

Migrations are named `vX.Y.Z.sql` where:
- X = major (breaking changes)
- Y = minor (new features)
- Z = patch (bug fixes)

## Running Migrations

Migrations run automatically on worker deployment via `runMigrations()` in `src/migrations.ts`.

## Creating New Migrations

1. Create `vX.Y.Z.sql` with SQL statements
2. Update `getMigrationsInRange()` in `src/migrations.ts`
3. Test locally with `wrangler d1 execute`
4. Deploy

## Migration Rules

- Never modify existing migrations
- Always add new migrations for schema changes
- Migrations must be idempotent (safe to re-run)
- Use transactions for multi-step migrations
