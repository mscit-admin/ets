-- ETS 1.12.x — a new test state for functions / report items: «غير متاح للاختبار» (not available for testing).
--
-- functions.test_status had five states after migration 025, constrained by
--   CHECK (test_status BETWEEN 0 AND 4)
-- whose constraint name is functions_test_status_check. One state is ADDED
-- (the existing five keep their numeric values; nothing is renumbered or rewritten):
--   0 لم تُختبر            (Not tested)              — unchanged (drives «untested», T2)
--   1 نجح مع ملاحظة        (Passed with note)        — unchanged (requires a note)
--   2 نجح                 (Passed)                  — unchanged («نجح» = 100 %, 1.8.1 / 1.12.21)
--   3 فشل                 (Failed)                  — unchanged (drives «failed_retest», T3)
--   4 إعادة الاختبار       (Needs re-testing)        — unchanged (requires a note, 1.12.25)
--   5 غير متاح للاختبار     (Not available for testing) — NEW: a NOT-passed state. It requires a note (like states 1
--                                                      and 4). It is NOT «نجح», so the «نجح» = 100 % rule is
--                                                      unaffected and tested_ok (tests[2]) is unchanged. It is not
--                                                      state 0, so it is excluded from «untested» (T2); no new alert
--                                                      or progress rule is added for it.
--
-- Forward-only and idempotent (like 025): widen the CHECK from 0..4 to 0..5 by name.
-- No data backfill; existing rows keep their values; DEFAULT 0 is unchanged.

ALTER TABLE functions DROP CONSTRAINT IF EXISTS functions_test_status_check;
ALTER TABLE functions ADD CONSTRAINT functions_test_status_check CHECK (test_status BETWEEN 0 AND 5);
