-- Holy Melody — schema khởi tạo (MySQL 8.0+ / MariaDB 10.6+, InnoDB, utf8mb4)
-- Quy ước: số dư/credit là BIGINT nguyên (không dùng số thực); tiền VNĐ là BIGINT.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- tài khoản
CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  google_sub VARCHAR(255) NOT NULL,
  email VARCHAR(320) NULL,
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  name VARCHAR(255) NULL,
  avatar_url VARCHAR(1024) NULL,
  status ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  UNIQUE KEY uq_users_google_sub (google_sub),
  KEY idx_users_email (email),
  KEY idx_users_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash BINARY(32) NOT NULL,              -- SHA-256 của token, không lưu token gốc
  csrf_token_hash BINARY(32) NULL,             -- cho phiên cookie trên website
  client ENUM('desktop','web') NOT NULL,
  user_agent VARCHAR(512) NULL,
  ip VARBINARY(16) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_users (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  role ENUM('viewer','support','finance','owner') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by BIGINT UNSIGNED NULL,
  CONSTRAINT fk_admin_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- ví credit
CREATE TABLE wallets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wallets_user (user_id),
  CONSTRAINT fk_wallets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_wallet_balance_nonneg CHECK (balance >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sổ cái: mỗi thay đổi số dư là một dòng, có trước/sau, tham chiếu nguồn và khóa idempotency
CREATE TABLE credit_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  wallet_id BIGINT UNSIGNED NOT NULL,
  amount BIGINT NOT NULL,                       -- dương = cộng, âm = trừ
  balance_before BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  type ENUM('signup_bonus','purchase','ai_charge','ai_refund','admin_adjustment','reversal') NOT NULL,
  reference_type ENUM('user','payment_order','ai_job','admin_adjustment') NOT NULL,
  reference_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  note VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_credit_tx_idem (idempotency_key),
  -- mỗi nguồn chỉ được tạo đúng một giao dịch mỗi loại (vd. một lần hoàn cho một job)
  UNIQUE KEY uq_credit_tx_ref (reference_type, reference_id, type),
  KEY idx_credit_tx_user (user_id, id),
  CONSTRAINT fk_credit_tx_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_credit_tx_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id),
  CONSTRAINT chk_credit_tx_math CHECK (balance_after = balance_before + amount AND balance_after >= 0 AND amount <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Lưu ý: admin_adjustment có reference_id = admin_credit_adjustments.id nên vẫn duy nhất.

-- ---------------------------------------------------------------- gói và thanh toán
CREATE TABLE credit_packages (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(100) NOT NULL,
  credits BIGINT NOT NULL,
  price_vnd BIGINT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_packages_code (code),
  CONSTRAINT chk_packages_positive CHECK (credits > 0 AND price_vnd > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO credit_packages (code, name, credits, price_vnd, sort_order) VALUES
  ('starter', 'Starter', 100, 100000, 1),
  ('creator', 'Creator', 300, 300000, 2),
  ('studio', 'Studio', 500, 500000, 3),
  ('professional', 'Professional', 1000, 1000000, 4);

CREATE TABLE payment_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  package_id INT UNSIGNED NOT NULL,
  amount_vnd BIGINT NOT NULL,                  -- chốt giá tại thời điểm tạo đơn
  credits BIGINT NOT NULL,
  status ENUM('pending','paid','failed','cancelled','expired','refunded') NOT NULL DEFAULT 'pending',
  gateway ENUM('payos','vnpay','momo') NOT NULL,
  gateway_order_id VARCHAR(64) NOT NULL,       -- mã gửi cho cổng (vd orderCode PayOS)
  gateway_transaction_id VARCHAR(128) NULL,
  checkout_url VARCHAR(2048) NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  paid_at DATETIME(3) NULL,
  UNIQUE KEY uq_orders_gateway (gateway, gateway_order_id),
  UNIQUE KEY uq_orders_idem (user_id, idempotency_key),
  UNIQUE KEY uq_orders_gateway_tx (gateway, gateway_transaction_id),
  KEY idx_orders_user (user_id, id),
  KEY idx_orders_status (status, created_at),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_orders_package FOREIGN KEY (package_id) REFERENCES credit_packages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mọi webhook/IPN nhận được đều lưu (kể cả chữ ký sai) để đối soát
CREATE TABLE payment_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payment_order_id BIGINT UNSIGNED NULL,
  gateway ENUM('payos','vnpay','momo') NOT NULL,
  gateway_event_id VARCHAR(191) NOT NULL,
  payload JSON NOT NULL,
  verification_status ENUM('valid','invalid_signature','amount_mismatch','unknown_order','duplicate','not_success') NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_events_gateway_event (gateway, gateway_event_id),
  KEY idx_events_order (payment_order_id),
  CONSTRAINT fk_events_order FOREIGN KEY (payment_order_id) REFERENCES payment_orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- AI
CREATE TABLE ai_pricing (
  job_type VARCHAR(32) NOT NULL PRIMARY KEY,
  credit_cost BIGINT NOT NULL,
  -- tùy chọn tính thêm theo phút audio (0 = tắt)
  credit_per_minute BIGINT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by BIGINT UNSIGNED NULL,
  CONSTRAINT chk_pricing CHECK (credit_cost >= 0 AND credit_per_minute >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ai_pricing (job_type, credit_cost) VALUES
  ('harmony', 10), ('singer', 10), ('lyrics', 10), ('other', 10);

CREATE TABLE ai_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  job_type VARCHAR(32) NOT NULL,
  input_reference VARCHAR(512) NOT NULL,       -- đường dẫn object storage của input (MusicXML + tham số)
  input_sha256 BINARY(32) NULL,
  params JSON NULL,
  status ENUM('pending','processing','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
  credit_cost BIGINT NOT NULL,
  provider VARCHAR(64) NULL,
  provider_job_id VARCHAR(191) NULL,
  progress TINYINT UNSIGNED NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 3,
  worker_id VARCHAR(64) NULL,
  lease_until DATETIME(3) NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1000) NULL,
  refundable TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  UNIQUE KEY uq_ai_jobs_idem (user_id, idempotency_key),
  KEY idx_ai_jobs_queue (status, id),
  KEY idx_ai_jobs_user (user_id, id),
  CONSTRAINT fk_ai_jobs_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_outputs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('full_mix','vocal','instrumental','harmony_json','lyrics_json','midi','musicxml') NOT NULL,
  file_path VARCHAR(1024) NOT NULL,            -- object storage, KHÔNG lưu audio trong MySQL
  format VARCHAR(16) NOT NULL,
  bytes BIGINT UNSIGNED NULL,
  sha256 BINARY(32) NULL,
  duration DECIMAL(10,3) NULL,                 -- giây (chỉ thông tin, không phải tiền)
  metadata JSON NULL,
  expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_outputs_job (job_id),
  CONSTRAINT fk_outputs_job FOREIGN KEY (job_id) REFERENCES ai_jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_provider_costs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(64) NOT NULL,
  cost_usd_micros BIGINT NOT NULL,             -- 1 USD = 1_000_000
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_costs_job (job_id),
  CONSTRAINT fk_costs_job FOREIGN KEY (job_id) REFERENCES ai_jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- quản trị & vận hành
CREATE TABLE admin_credit_adjustments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  admin_user_id BIGINT UNSIGNED NOT NULL,
  amount BIGINT NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_adj_user (user_id),
  CONSTRAINT fk_adj_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_adj_admin FOREIGN KEY (admin_user_id) REFERENCES users(id),
  CONSTRAINT chk_adj_reason CHECK (CHAR_LENGTH(reason) >= 5 AND amount <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT UNSIGNED NULL,
  actor_type ENUM('user','admin','system','gateway','worker') NOT NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NULL,
  target_id BIGINT UNSIGNED NULL,
  details JSON NULL,
  ip VARBINARY(16) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_target (target_type, target_id),
  KEY idx_audit_actor (actor_user_id, id),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rate_limits (
  bucket VARCHAR(191) NOT NULL,
  window_start INT UNSIGNED NOT NULL,
  hits INT UNSIGNED NOT NULL,
  PRIMARY KEY (bucket, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE app_releases (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  version VARCHAR(32) NOT NULL,
  platform ENUM('macos','windows') NOT NULL,
  architecture ENUM('arm64','x64') NOT NULL,
  download_url VARCHAR(1024) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  checksum CHAR(64) NOT NULL,                  -- SHA-256 hex
  signature TEXT NULL,                         -- chữ ký Tauri updater
  signed TINYINT(1) NOT NULL DEFAULT 0,        -- đã ký mã (Apple notarized / Authenticode) hay chưa
  release_notes TEXT NULL,
  min_os_version VARCHAR(32) NULL,
  published_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_release (version, platform, architecture),
  CONSTRAINT chk_checksum CHECK (checksum REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE error_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source ENUM('api','webhook','worker','desktop') NOT NULL,
  level ENUM('warning','error','critical') NOT NULL,
  message VARCHAR(2000) NOT NULL,
  context JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_errors_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version) VALUES ('001_init');
