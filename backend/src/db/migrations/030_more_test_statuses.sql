-- ETS 1.12.x — two new test states for functions / report items: «لم يتم عرضها» (not presented)
-- and «لم يتم التدريب» (not trained).
--
-- functions.test_status had six states after migration 029, constrained by
--   CHECK (test_status BETWEEN 0 AND 5)
-- whose constraint name is functions_test_status_check. Two states are APPENDED
-- (the existing six keep their numeric values; nothing is renumbered or rewritten):
--   0 لم تُختبر            (Not tested)              — unchanged (drives «untested», T2)
--   1 نجح مع ملاحظة        (Passed with note)        — unchanged (requires a note)
--   2 نجح                 (Passed)                  — unchanged («نجح» = 100 %, 1.8.1 / 1.12.21)
--   3 فشل                 (Failed)                  — unchanged (drives «failed_retest», T3)
--   4 إعادة الاختبار       (Needs re-testing)        — unchanged (requires a note, 1.12.25)
--   5 غير متاح للاختبار     (Not available for testing) — unchanged (requires a note, migration 029)
--   6 لم يتم عرضها         (Not presented)           — NEW: a NOT-passed state. It requires a note (like states 1,
--                                                      4 and 5). It is NOT «نجح», so the «نجح» = 100 % rule is
--                                                      unaffected and tested_ok (tests[2]) is unchanged. It is not
--                                                      state 0 («لم تُختبر»), so it is excluded from «untested» (T2);
--                                                      no new alert or progress rule is added for it.
--   7 لم يتم التدريب        (Not trained)             — NEW: a NOT-passed state, same rules as state 6 (requires a
--                                                      note, not «نجح», not state 0, no new alert or progress rule).
--
-- Forward-only and idempotent (like 025 / 029): widen the CHECK from 0..5 to 0..7 by name.
-- No data backfill; existing rows keep their values; DEFAULT 0 is unchanged.

ALTER TABLE functions DROP CONSTRAINT IF EXISTS functions_test_status_check;
ALTER TABLE functions ADD CONSTRAINT functions_test_status_check CHECK (test_status BETWEEN 0 AND 7);
