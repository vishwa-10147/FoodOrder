CREATE TABLE IF NOT EXISTS restaurants (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  cuisines TEXT NOT NULL DEFAULT 'South Indian, Indian',
  rating DOUBLE PRECISION NOT NULL DEFAULT 4.1,
  rating_count TEXT NOT NULL DEFAULT '1.4K+ ratings',
  price_for_two INTEGER NOT NULL DEFAULT 150,
  accepting_orders INTEGER NOT NULL DEFAULT 1,
  reopen_note TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id BIGINT NOT NULL DEFAULT 1 REFERENCES restaurants(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  category TEXT NOT NULL,
  image_url TEXT,
  available INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS table_status (
  restaurant_id BIGINT NOT NULL DEFAULT 1 REFERENCES restaurants(id),
  table_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('free','ordering','occupied')),
  PRIMARY KEY (restaurant_id, table_number)
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id BIGINT NOT NULL DEFAULT 1 REFERENCES restaurants(id),
  order_type TEXT NOT NULL CHECK (order_type IN ('dine','takeaway','preorder')),
  table_number INTEGER,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('new','preparing','ready','delivered')),
  source TEXT NOT NULL DEFAULT 'direct',
  external_order_id TEXT,
  paid INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  payment_gateway_order_id TEXT,
  payment_gateway_payment_id TEXT,
  paid_at BIGINT,
  eta_minutes INTEGER NOT NULL DEFAULT 15,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id BIGINT NOT NULL,
  item_name TEXT NOT NULL,
  item_price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  actor TEXT NOT NULL,
  details TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS restaurant_auth (
  restaurant_id BIGINT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_order_id
ON orders(external_order_id)
WHERE external_order_id IS NOT NULL;
