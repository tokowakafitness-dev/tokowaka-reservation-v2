-- 設計39 の続き（2026-11-12）：トレーナーの読み（かな）を写しに持たせる
--   書くのは GAS の押し出し（trainer_master の見出し「kana」の列・無ければ空文字）。読むのは k_aiDraft の伏せる処理と日次点検の数（数だけ）
--   ★既定値を入れない（MODEL §8）。NULL／空文字＝伏せられない（今と同じ動き）
--   ★個人情報（スタッフの名前の読み）。画面・応答へ返す経路を作らない（SELECT * をしない・I76）
ALTER TABLE trainers ADD COLUMN kana TEXT;
