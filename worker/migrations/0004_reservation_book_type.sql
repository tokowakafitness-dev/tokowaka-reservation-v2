-- 2026-09-28：予約の「種別」を写しに持たせる。
--   会員のマイ予約で「チケット」「通常」のラベル表示に使う。
ALTER TABLE reservations ADD COLUMN book_type TEXT;
