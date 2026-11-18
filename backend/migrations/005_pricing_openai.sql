-- Holy Melody — chuyển bản nhạc sang Editor: 50 credit; AI Singer qua OpenAI
UPDATE ai_pricing SET credit_cost = 50 WHERE job_type = 'omr_edit';
INSERT INTO ai_pricing (job_type, credit_cost) VALUES ('singer_render', 10) ON DUPLICATE KEY UPDATE credit_cost = credit_cost;
