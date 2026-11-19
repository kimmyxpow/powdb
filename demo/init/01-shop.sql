-- Demo database for pow/view.
-- Loaded automatically by demo/docker-compose.yml (docker-entrypoint-initdb.d).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- public: a small e-commerce shop
-- ---------------------------------------------------------------------------

CREATE TYPE product_status AS ENUM ('draft', 'active', 'archived');
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded');

CREATE TABLE customers (
  id            serial PRIMARY KEY,
  email         citext NOT NULL UNIQUE,
  full_name     text NOT NULL,
  phone         text,
  country_code  char(2) NOT NULL DEFAULT 'ID',
  is_active     boolean NOT NULL DEFAULT true,
  loyalty_points integer NOT NULL DEFAULT 0,
  tags          text[] NOT NULL DEFAULT '{}',
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  birth_date    date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE customers IS 'People who have an account in the shop';
COMMENT ON COLUMN customers.loyalty_points IS 'Points earned from completed orders';

CREATE TABLE categories (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  parent_id  integer REFERENCES categories (id) ON DELETE SET NULL
);
COMMENT ON TABLE categories IS 'Hierarchical product categories';

CREATE TABLE products (
  id           serial PRIMARY KEY,
  sku          text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text,
  category_id  integer REFERENCES categories (id),
  price        numeric(10, 2) NOT NULL CHECK (price >= 0),
  stock        integer NOT NULL DEFAULT 0,
  status       product_status NOT NULL DEFAULT 'draft',
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  weight_kg    real,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_attributes_gin ON products USING gin (attributes);
COMMENT ON TABLE products IS 'Everything we sell';

CREATE TABLE orders (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id       integer NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  status            order_status NOT NULL DEFAULT 'pending',
  total             numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_address  jsonb,
  notes             text,
  placed_at         timestamptz NOT NULL DEFAULT now(),
  shipped_at        timestamptz
);
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE INDEX orders_status_placed_idx ON orders (status, placed_at DESC);

CREATE TABLE order_items (
  order_id    bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id  integer NOT NULL REFERENCES products (id),
  quantity    integer NOT NULL CHECK (quantity > 0),
  unit_price  numeric(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
COMMENT ON TABLE order_items IS 'Line items (composite primary key)';

CREATE TABLE reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   integer NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  customer_id  integer REFERENCES customers (id) ON DELETE SET NULL,
  rating       smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title        text,
  body         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A table without a primary key (edited through ctid)
CREATE TABLE audit_log (
  event     text NOT NULL,
  actor     text,
  payload   jsonb,
  ip        inet,
  at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE audit_log IS 'Append-only log without a primary key';

-- updated_at trigger
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER products_set_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION order_total(p_order_id bigint) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(quantity * unit_price), 0)
  FROM order_items
  WHERE order_id = p_order_id;
$$;
COMMENT ON FUNCTION order_total(bigint) IS 'Sum of all line items of an order';

CREATE PROCEDURE archive_old_products(p_before timestamptz)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE products SET status = 'archived'
  WHERE updated_at < p_before AND status <> 'archived';
END;
$$;

-- ---------------------------------------------------------------------------
-- Sample data
-- ---------------------------------------------------------------------------

SELECT setseed(0.42);

INSERT INTO categories (name, slug, parent_id) VALUES
  ('Electronics', 'electronics', NULL),
  ('Computers', 'computers', 1),
  ('Phones', 'phones', 1),
  ('Audio', 'audio', 1),
  ('Home & Kitchen', 'home-kitchen', NULL),
  ('Furniture', 'furniture', 5),
  ('Cookware', 'cookware', 5),
  ('Books', 'books', NULL),
  ('Fiction', 'fiction', 8),
  ('Non-fiction', 'non-fiction', 8),
  ('Sports', 'sports', NULL),
  ('Outdoor', 'outdoor', 11);

INSERT INTO customers (email, full_name, phone, country_code, is_active, loyalty_points, tags, metadata, birth_date, created_at)
SELECT
  lower(f.first || '.' || l.last || g.i || '@example.com'),
  f.first || ' ' || l.last,
  CASE WHEN random() < 0.8 THEN '+62 8' || (100000000 + floor(random() * 899999999))::bigint END,
  (ARRAY['ID', 'SG', 'MY', 'US', 'NL', 'JP', 'AU'])[1 + floor(random() * 7)::int],
  random() < 0.9,
  floor(random() * 5000)::int,
  CASE floor(random() * 5)::int
    WHEN 0 THEN ARRAY['vip']
    WHEN 1 THEN ARRAY['newsletter']
    WHEN 2 THEN ARRAY['vip', 'newsletter']
    WHEN 3 THEN ARRAY['wholesale']
    ELSE ARRAY[]::text[]
  END,
  jsonb_build_object(
    'source', (ARRAY['organic', 'ads', 'referral', 'social'])[1 + floor(random() * 4)::int],
    'newsletter', random() < 0.5,
    'preferences', jsonb_build_object('theme', (ARRAY['light', 'dark'])[1 + floor(random() * 2)::int], 'language', (ARRAY['id', 'en'])[1 + floor(random() * 2)::int])
  ),
  CASE WHEN random() < 0.7 THEN date '1960-01-01' + floor(random() * 16000)::int END,
  now() - (random() * interval '900 days')
FROM generate_series(1, 240) AS g(i)
CROSS JOIN LATERAL (
  SELECT (ARRAY['Ayu', 'Budi', 'Citra', 'Dewi', 'Eka', 'Fajar', 'Gita', 'Hadi', 'Indah', 'Joko', 'Kirana', 'Lestari', 'Maya', 'Nanda', 'Oki', 'Putri', 'Rizky', 'Sari', 'Tono', 'Wulan', 'Alice', 'Bob', 'Chen', 'Diego', 'Emma', 'Hiro'])[1 + floor(random() * 26)::int] AS first, g.i AS seed
) f
CROSS JOIN LATERAL (
  SELECT (ARRAY['Pratama', 'Santoso', 'Wijaya', 'Kusuma', 'Halim', 'Saputra', 'Nugroho', 'Lim', 'Tan', 'Smith', 'Garcia', 'Tanaka', 'Rahman', 'Hidayat'])[1 + floor(random() * 14)::int] AS last, f.seed
) l;

INSERT INTO products (sku, name, description, category_id, price, stock, status, attributes, weight_kg, created_at)
SELECT
  'SKU-' || lpad(g.i::text, 5, '0'),
  p.adj || ' ' || p.noun,
  CASE WHEN random() < 0.85 THEN 'A ' || lower(p.adj) || ' ' || lower(p.noun) || ' that customers love. Built to last and easy to use.' END,
  2 + floor(random() * 11)::int,
  round((5 + random() * 1500)::numeric, 2),
  floor(random() * 500)::int,
  (ARRAY['draft', 'active', 'active', 'active', 'archived']::product_status[])[1 + floor(random() * 5)::int],
  jsonb_build_object(
    'color', (ARRAY['black', 'white', 'silver', 'blue', 'red', 'green'])[1 + floor(random() * 6)::int],
    'warranty_months', (ARRAY[0, 6, 12, 24])[1 + floor(random() * 4)::int],
    'dimensions', jsonb_build_object('w', floor(random() * 60), 'h', floor(random() * 60), 'd', floor(random() * 60))
  ),
  round((0.1 + random() * 20)::numeric, 2)::real,
  now() - (random() * interval '700 days')
FROM generate_series(1, 150) AS g(i)
CROSS JOIN LATERAL (
  SELECT
    (ARRAY['Ultra', 'Smart', 'Classic', 'Pro', 'Mini', 'Eco', 'Wireless', 'Compact', 'Premium', 'Rugged'])[1 + floor(random() * 10)::int] AS adj,
    (ARRAY['Laptop', 'Headphones', 'Kettle', 'Chair', 'Backpack', 'Novel', 'Speaker', 'Monitor', 'Tent', 'Pan', 'Phone', 'Lamp', 'Desk', 'Keyboard', 'Bottle'])[1 + floor(random() * 15)::int] AS noun,
    g.i AS seed
) p;

INSERT INTO orders (customer_id, status, shipping_address, notes, placed_at, shipped_at)
SELECT
  c.id,
  s.status,
  jsonb_build_object('street', 'Jl. Merdeka No. ' || floor(random() * 200)::int, 'city', (ARRAY['Jakarta', 'Bandung', 'Surabaya', 'Singapore', 'Kuala Lumpur'])[1 + floor(random() * 5)::int], 'postal_code', lpad(floor(random() * 99999)::text, 5, '0')),
  CASE WHEN random() < 0.15 THEN 'Please leave the package at the front desk.' END,
  s.placed_at,
  CASE WHEN s.status IN ('shipped', 'delivered') THEN s.placed_at + (random() * interval '5 days') END
FROM generate_series(1, 2500) AS g(i)
CROSS JOIN LATERAL (SELECT id FROM customers OFFSET floor(random() * 240)::int + (g.i * 0) LIMIT 1) c
CROSS JOIN LATERAL (
  SELECT
    (ARRAY['pending', 'paid', 'shipped', 'delivered', 'delivered', 'delivered', 'cancelled', 'refunded']::order_status[])[1 + floor(random() * 8)::int] AS status,
    now() - (random() * interval '600 days') AS placed_at,
    g.i AS seed
) s;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT DISTINCT ON (o.id, p.id)
  o.id, p.id, 1 + floor(random() * 4)::int, p.price
FROM orders o
CROSS JOIN LATERAL generate_series(1, 1 + floor(random() * 4)::int + (o.id * 0)::int) AS n(k)
CROSS JOIN LATERAL (SELECT id, price FROM products OFFSET floor(random() * 150)::int + (n.k * 0) + (o.id * 0) LIMIT 1) p;

UPDATE orders o SET total = order_total(o.id);

UPDATE customers c SET loyalty_points = coalesce((
  SELECT floor(sum(total) / 10)::int FROM orders WHERE customer_id = c.id AND status = 'delivered'
), 0);

INSERT INTO reviews (product_id, customer_id, rating, title, body, created_at)
SELECT
  p.id,
  c.id,
  r.rating,
  (ARRAY['Great value', 'Not bad', 'Exceeded expectations', 'Would not buy again', 'Solid product', 'Okay-ish'])[1 + floor(random() * 6)::int],
  CASE WHEN random() < 0.8 THEN 'I have been using it for a few weeks now. ' || (ARRAY['Totally worth it.', 'Shipping was slow.', 'Quality is great.', 'Packaging could be better.'])[1 + floor(random() * 4)::int] END,
  now() - (random() * interval '400 days')
FROM generate_series(1, 900) AS g(i)
CROSS JOIN LATERAL (SELECT id FROM products OFFSET floor(random() * 150)::int + (g.i * 0) LIMIT 1) p
CROSS JOIN LATERAL (SELECT id FROM customers OFFSET floor(random() * 240)::int + (g.i * 0) LIMIT 1) c
CROSS JOIN LATERAL (SELECT (ARRAY[1, 2, 3, 4, 4, 5, 5, 5])[1 + floor(random() * 8)::int]::smallint AS rating, g.i AS seed) r;

INSERT INTO audit_log (event, actor, payload, ip, at)
SELECT
  (ARRAY['login', 'logout', 'order.created', 'order.paid', 'product.updated', 'password.reset'])[1 + floor(random() * 6)::int],
  CASE WHEN random() < 0.9 THEN 'user_' || floor(random() * 240)::int END,
  jsonb_build_object('request_id', md5(g.i::text), 'ok', random() < 0.95),
  ('10.0.' || floor(random() * 255)::int || '.' || floor(random() * 255)::int)::inet,
  now() - (random() * interval '30 days')
FROM generate_series(1, 400) AS g(i);

CREATE VIEW customer_order_summary AS
SELECT
  c.id AS customer_id,
  c.full_name,
  c.email,
  count(o.id) AS orders,
  coalesce(sum(o.total) FILTER (WHERE o.status NOT IN ('cancelled', 'refunded')), 0) AS lifetime_value,
  max(o.placed_at) AS last_order_at
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id;
COMMENT ON VIEW customer_order_summary IS 'Per-customer order statistics';

CREATE MATERIALIZED VIEW product_sales AS
SELECT
  p.id AS product_id,
  p.name,
  sum(oi.quantity) AS units_sold,
  sum(oi.quantity * oi.unit_price) AS revenue
FROM products p
JOIN order_items oi ON oi.product_id = p.id
JOIN orders o ON o.id = oi.order_id AND o.status IN ('paid', 'shipped', 'delivered')
GROUP BY p.id, p.name;

-- ---------------------------------------------------------------------------
-- analytics: a second schema with a bigger table (pagination testing)
-- ---------------------------------------------------------------------------

CREATE SCHEMA analytics;
COMMENT ON SCHEMA analytics IS 'Website analytics';

CREATE TABLE analytics.page_views (
  id           bigserial PRIMARY KEY,
  path         text NOT NULL,
  referrer     text,
  user_agent   text,
  country_code char(2),
  duration_ms  integer,
  viewed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX page_views_viewed_at_idx ON analytics.page_views (viewed_at);

INSERT INTO analytics.page_views (path, referrer, user_agent, country_code, duration_ms, viewed_at)
SELECT
  (ARRAY['/', '/products', '/products/ultra-laptop', '/cart', '/checkout', '/blog', '/about', '/login'])[1 + floor(random() * 8)::int],
  (ARRAY[NULL, 'https://google.com', 'https://twitter.com', 'https://news.ycombinator.com', NULL])[1 + floor(random() * 5)::int],
  (ARRAY['Mozilla/5.0 (Macintosh)', 'Mozilla/5.0 (Windows NT 10.0)', 'Mozilla/5.0 (iPhone)', 'Mozilla/5.0 (Linux; Android 14)'])[1 + floor(random() * 4)::int],
  (ARRAY['ID', 'SG', 'MY', 'US', 'NL', 'JP'])[1 + floor(random() * 6)::int],
  floor(random() * 120000)::int,
  now() - (random() * interval '90 days')
FROM generate_series(1, 25000) AS g(i);

CREATE VIEW analytics.daily_views AS
SELECT date_trunc('day', viewed_at)::date AS day, count(*) AS views, round(avg(duration_ms)) AS avg_duration_ms
FROM analytics.page_views
GROUP BY 1
ORDER BY 1 DESC;

ANALYZE;
