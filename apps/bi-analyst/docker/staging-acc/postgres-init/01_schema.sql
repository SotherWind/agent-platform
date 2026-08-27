-- bi-analyst staging-acc demo schema (PostgreSQL)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(12, 2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO users (name, city) VALUES
  ('Alice', '北京'),
  ('Bob', '上海'),
  ('Charlie', '北京');

INSERT INTO orders (user_id, amount, status) VALUES
  (1, 299.99, 'paid'),
  (1, 599.00, 'shipped'),
  (2, 150.50, 'paid'),
  (3, 1200.00, 'pending');
