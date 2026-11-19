-- A second database, to try out switching databases on the same server.
CREATE DATABASE warehouse;

\connect warehouse

CREATE TABLE locations (
  id        serial PRIMARY KEY,
  code      text NOT NULL UNIQUE,
  city      text NOT NULL,
  capacity  integer NOT NULL
);

CREATE TABLE stock_movements (
  id           bigserial PRIMARY KEY,
  location_id  integer NOT NULL REFERENCES locations (id),
  sku          text NOT NULL,
  delta        integer NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('inbound', 'outbound', 'adjustment', 'return')),
  moved_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO locations (code, city, capacity) VALUES
  ('JKT-01', 'Jakarta', 12000),
  ('BDG-01', 'Bandung', 6000),
  ('SUB-01', 'Surabaya', 8000),
  ('SIN-01', 'Singapore', 4000);

INSERT INTO stock_movements (location_id, sku, delta, reason, moved_at)
SELECT
  1 + floor(random() * 4)::int,
  'SKU-' || lpad((1 + floor(random() * 150))::text, 5, '0'),
  (floor(random() * 200) - 80)::int,
  (ARRAY['inbound', 'outbound', 'adjustment', 'return'])[1 + floor(random() * 4)::int],
  now() - (random() * interval '120 days')
FROM generate_series(1, 3000);

ANALYZE;
