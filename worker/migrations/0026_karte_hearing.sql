-- 設計31 カルテのヒアリング構造化と見せ方（2026-11-04）
--   列を足すだけ（NOT NULL は付けない＝既存の行は NULL）。中身の検査の正本は Worker（列挙・件数・重複・順序）。
--   ここでは JSON として読めること・タグの値だけを守る。新しいタグを足すときはこの CHECK も直す

-- ヒアリング（健康情報ではない項目だけ）
ALTER TABLE karte_profile ADD COLUMN hearing_json TEXT CHECK (hearing_json IS NULL OR json_valid(hearing_json));

-- 安全面（健康情報）：痛みの身体図・医師の診断。同意の撤回で行ごと消える（saveConsent）
ALTER TABLE karte_safety ADD COLUMN pain_json TEXT CHECK (pain_json IS NULL OR json_valid(pain_json));
ALTER TABLE karte_safety ADD COLUMN diagnosis TEXT;

-- 指導の履歴：タグ・変化の理由（健康の選択肢は入れない）・次回確かめること
ALTER TABLE karte_notes ADD COLUMN tag TEXT CHECK (tag IS NULL OR tag IN ('training', 'meal', 'life', 'body'));
ALTER TABLE karte_notes ADD COLUMN reasons_json TEXT CHECK (reasons_json IS NULL OR json_valid(reasons_json));
ALTER TABLE karte_notes ADD COLUMN next_check TEXT;
