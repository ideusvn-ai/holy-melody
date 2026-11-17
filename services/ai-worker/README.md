# AI worker (Phase 5)
Tiến trình riêng (không chạy trong request PHP). Vòng lặp: `POST /api/v1/worker/claim` → xử lý bằng adapter
trong `packages/ai-provider-sdk` (SVS theo nốt, hòa âm, mix/master) → `progress` / `complete` / `fail`.
Xác thực bằng `HM_WORKER_TOKEN`. Lỗi tạm thời: `retryable=true` (không tốn thêm credit); lỗi hệ thống: `refundable=true`.
