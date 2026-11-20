-- Turns on pg_stat_statements, so the Health section can list the slowest queries.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
