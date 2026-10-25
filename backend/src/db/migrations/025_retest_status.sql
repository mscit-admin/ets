-- ETS 1.12.25 — a new test state for functions / report items: «إعادة الاختبار» (needs re-testing).
--
-- functions.test_status (migration 001) had four states, constrained inline by
--   CHECK (test_status BETWEEN 0 AND 3)
-- whose auto-generated constraint name is functions_test_status_check. One state is ADDED
-- (the existing four keep their numeric values; nothing is renumbered or rewritten):
--   0 لم تُختبر        (Not tested)         — unchanged (drives «untested», T2)
--   1 نجح مع ملاحظة    (Passed with note)   — unchanged (requires a note)
--   2 نجح             (Passed)             — unchanged («نجح» = 100 %, 1.8.1 / 1.12.21)
--   3 فشل             (Failed)             — unchanged (drives «failed_retest», T3)
--   4 إعادة الاختبار   (Needs re-testing)   — NEW: a NOT-passed, needs-testing state. It requires a note
--                                            (like state 1) and drives a new tester alert «retest» (T10) when an
--                                            item stays in it past notify.retest_days. It is NOT «نجح», so the
--                                            «نجح» = 100 % rule is unaffected and tested_ok (tests[2]) is unchanged.
--
-- Forward-only and idempotent (like 022 / 023): widen the CHECK from 0..3 to 0..4 by name.
-- No data backfill; existing rows keep their values; DEFAULT 0 is unchanged.

ALTER TABLE functions DROP CONSTRAINT IF EXISTS functions_test_status_check;
ALTER TABLE functions ADD CONSTRAINT functions_test_status_check CHECK (test_status BETWEEN 0 AND 4);
