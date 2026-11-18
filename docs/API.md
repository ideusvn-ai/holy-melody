# Holy Melody REST API v1

Định dạng JSON, lỗi: `{"error":{"code","message","details"?}}`. Xác thực: `Authorization: Bearer <token>` (desktop) hoặc cookie `hm_session` + header `X-CSRF-Token` (website).

| Phương thức | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/api/v1/health` | Kiểm tra dịch vụ |
| POST | `/api/v1/auth/google` | `{id_token, client: desktop\|web}` → phiên; tài khoản mới +100 credit (một lần) |
| POST | `/api/v1/auth/logout` | Thu hồi phiên |
| GET | `/api/v1/me` | Người dùng + số dư |
| GET | `/api/v1/me/transactions?limit&before` | Sổ cái credit |
| GET | `/api/v1/pricing` | Gói credit + giá AI (`available` = máy chủ đã bật) |
| POST | `/api/v1/payments/orders` | `{package_id, gateway}` + `Idempotency-Key` → `checkout_url` |
| GET | `/api/v1/payments/orders/{id}` | Trạng thái đơn |
| POST | `/api/v1/webhooks/sepay` | Webhook SePay (HMAC-SHA256 `X-Sepay-Signature` hoặc `Authorization: Apikey`); cộng credit một lần khi tiền vào đúng tài khoản + mã + số tiền |
| GET | `/api/v1/pay/{code}` | Thông tin trang thanh toán (QR, ngân hàng, số tiền, trạng thái) theo mã thanh toán |
| POST | `/api/v1/ai/inputs` | `{format:"musicxml", content}` → `input_reference` |
| GET | `/api/v1/omr/edit-price` | Giá chuyển ảnh/PDF sang Edit (mặc định 10 credit) |
| POST | `/api/v1/omr/edit-conversions` | `{source_hash, title, pages, measures}` → trừ credit **một lần** cho mỗi (người dùng, file gốc); gọi lại trả kết quả cũ (`replayed: true`) |
| POST | `/api/v1/ai/jobs` | `{type, input_reference, params}` + `Idempotency-Key` → trừ credit một lần |
| GET | `/api/v1/ai/jobs` · `/api/v1/ai/jobs/{id}` | Danh sách / chi tiết + outputs |
| POST | `/api/v1/ai/jobs/{id}/cancel` | Hủy job đang chờ, hoàn credit |
| GET | `/api/v1/ai/outputs/{id}` | Tải file kết quả (chủ sở hữu, còn hạn) |
| GET | `/api/v1/releases/latest` | Bản phát hành mới nhất mỗi nền tảng |
| POST | `/api/v1/worker/claim`, `/worker/jobs/{id}/progress\|complete\|fail` | Dành cho AI worker (`HM_WORKER_TOKEN`) |
| GET | `/api/v1/admin/stats\|metrics\|users\|orders\|payment-events\|jobs\|errors` | Quản trị (viewer+) |
| POST | `/api/v1/admin/users/{id}/credits` | Điều chỉnh credit, bắt buộc lý do, ghi audit (finance) |
| PUT | `/api/v1/admin/pricing/{type}` · `/api/v1/admin/packages/{id}` | Giá AI / gói (finance) |
| POST | `/api/v1/admin/releases` | Đăng bản phát hành (owner) |
