-- Holy Melody — lượt AI đọc lại vùng khó (giới hạn theo mỗi lần chuyển sang Editor)
CREATE TABLE omr_ai_calls (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversion_id BIGINT UNSIGNED NOT NULL,
  model VARCHAR(80) NOT NULL,
  http_status INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_omr_ai_conv (conversion_id),
  CONSTRAINT fk_omr_ai_conv FOREIGN KEY (conversion_id) REFERENCES omr_conversions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
