-- Holy Melody — chuyển thanh toán sang SePay (chuyển khoản VietQR + webhook). Giữ giá trị cũ cho lịch sử đơn.
ALTER TABLE payment_orders MODIFY gateway ENUM('payos','vnpay','momo','sepay') NOT NULL;
ALTER TABLE payment_events MODIFY gateway ENUM('payos','vnpay','momo','sepay') NOT NULL;
