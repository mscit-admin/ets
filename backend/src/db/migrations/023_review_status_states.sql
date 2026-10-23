-- ETS 1.12.17 — two new review states for functions / report items.
--
-- functions.review_status (migration 001) had four states, constrained inline by
--   CHECK (review_status BETWEEN 0 AND 3)
-- whose auto-generated constraint name is functions_review_status_check. Two states are ADDED
-- (the existing four keep their numeric values; nothing is renumbered or rewritten):
--   0 لا توجد حاجة للمراجعة   (No review needed)   — kept, relabelled from «لا تحتاج»
--   1 موجودة                 (Present)            — unchanged
--   2 غير موجودة             (Missing)            — unchanged (still drives «in_review_missing»)
--   3 ملاحظات                (Notes)              — kept, relabelled from «موجودة مع ملاحظات»
--   4 إطلاع                  (Acknowledged)       — NEW, a completed review (NOT missing)
--   5 اعتماد                 (Approved)           — NEW, a completed review (NOT missing)
--
-- Forward-only and idempotent (like 022): widen the CHECK from 0..3 to 0..5 by name.
-- No data backfill; existing rows keep their values; DEFAULT 0 is unchanged.

ALTER TABLE functions DROP CONSTRAINT IF EXISTS functions_review_status_check;
ALTER TABLE functions ADD CONSTRAINT functions_review_status_check CHECK (review_status BETWEEN 0 AND 5);
