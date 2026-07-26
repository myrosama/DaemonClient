// Types for `schema.mjs`, hand-written because that file is deliberately plain
// JavaScript: it is consumed by a TypeScript worker AND by a dependency-free
// `.mjs` CLI, so it cannot be compiled without giving one of them a build step.
export const MIGRATION_SQL: string;
export const DRIVE_MIGRATION_SQL: string;
export function splitStatements(sql: string): string[];
