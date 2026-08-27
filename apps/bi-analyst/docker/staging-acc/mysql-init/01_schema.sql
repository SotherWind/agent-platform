-- bi-analyst staging-acc demo schema (MySQL, 无 mTLS)
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  city VARCHAR(64) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
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
