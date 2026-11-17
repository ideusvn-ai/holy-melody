-- Holy Melody — chuyển bản nhạc ảnh/PDF sang chế độ biên tập (10 credit, đúng một lần cho mỗi bản nhạc của mỗi người dùng)
ALTER TABLE credit_transactions
  MODIFY type ENUM('signup_bonus','purchase','ai_charge','ai_refund','admin_adjustment','reversal','omr_charge') NOT NULL,
  MODIFY reference_type ENUM('user','payment_order','ai_job','admin_adjustment','omr_conversion') NOT NULL;

CREATE TABLE omr_conversions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  source_hash CHAR(64) NOT NULL,             -- SHA-256 của file ảnh/PDF gốc
  title VARCHAR(255) NOT NULL DEFAULT '',
  pages INT UNSIGNED NOT NULL DEFAULT 1,
  measures INT UNSIGNED NOT NULL DEFAULT 0,
  credit_cost BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_omr_conv (user_id, source_hash),
  CONSTRAINT fk_omr_conv_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ai_pricing (job_type, credit_cost) VALUES ('omr_edit', 10)
  ON DUPLICATE KEY UPDATE credit_cost = credit_cost;
