-- 設計39 の続き（2026-11-12）：確かめたセットの数を記録に足す（確かめられない数字の割合の分母）
--   ★既定値を入れない。以前の行は NULL＝割合に入れない（日次点検は n_sets のある成功だけで割る）
ALTER TABLE karte_ai_log ADD COLUMN n_sets INTEGER;
