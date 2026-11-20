-- 設計49（2026-11-20）：AI の下書きの v2（推論・要約 → カルテの形・数字の4つの状態）の記録の列
--   ★既定値を入れない。以前の行は NULL（v1 の行・この列ができる前の行）。中身（文字起こし・AI の文）を入れる列は持たない（I76-3）
--   fmt＝実際に使った形式（'v1'/'v2'）・effort＝実際に送った考える量（'low'/'medium'）・client_req_id＝画面が作った乱数の番号（形が違えば NULL）
ALTER TABLE karte_ai_log ADD COLUMN fmt TEXT;
ALTER TABLE karte_ai_log ADD COLUMN effort TEXT;
ALTER TABLE karte_ai_log ADD COLUMN client_req_id TEXT;
ALTER TABLE karte_ai_log ADD COLUMN n_inferred INTEGER;
ALTER TABLE karte_ai_log ADD COLUMN n_nobasis INTEGER;
ALTER TABLE karte_ai_log ADD COLUMN n_health_hidden INTEGER;
ALTER TABLE karte_ai_log ADD COLUMN n_unclear INTEGER;
ALTER TABLE karte_ai_log ADD COLUMN n_summary INTEGER;
ALTER TABLE karte_ai_log ADD COLUMN stream_events INTEGER;
ALTER TABLE karte_ai_log ADD COLUMN stream_bytes INTEGER;
