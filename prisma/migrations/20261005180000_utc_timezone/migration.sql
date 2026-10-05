-- Prisma stores DateTime values as UTC in "timestamp without time zone" columns.
-- Raw SQL compares those columns with timestamptz parameters, so the session time zone must be UTC.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END
$$;
