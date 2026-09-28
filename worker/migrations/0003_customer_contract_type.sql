-- 2026-09-28：顧客の「契約種別」を写しに持たせる。
--   会員のホームを画面へ返すとき、GASと同じ形にするために必要。
ALTER TABLE customers ADD COLUMN contract_type TEXT;
