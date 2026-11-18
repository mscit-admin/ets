#!/usr/bin/env bash
# unlock-accounts.sh — عرض الحسابات المقفولة (بسبب محاولات الدخول الفاشلة) ثم فكّ قفلها بعد تأكيد المشغّل.
#
# الأمان:
#   - يعرض الحسابات المقفولة فعلاً أولاً (locked_until في المستقبل) — قراءة فقط — ولا يغيّر شيئاً قبل تأكيدك.
#   - يطلب كتابة  yes  صريحةً قبل أي تعديل؛ أي إدخال آخر يُلغي العملية دون تغيير.
#   - لا يلمس أي حساب غير مقفول. "فكّ القفل" = تصفير failed_attempts و locked_until و last_failed_at فقط،
#     ولا يغيّر كلمة المرور ولا الصلاحيات ولا حالة التفعيل.
#
# الاستخدام:
#   sudo bash deploy/scripts/unlock-accounts.sh                 # كل الحسابات المقفولة حالياً
#   sudo bash deploy/scripts/unlock-accounts.sh user1 user2     # أسماء/بُرُد محدّدة فقط
#   # إعدادات الاتصال تُقرأ تلقائياً من /etc/ets/ets.env (متغيّرات PG*)؛ أو مرّرها صراحةً في البيئة:
#   sudo PGHOST=127.0.0.1 PGDATABASE=ets PGUSER=ets PGPASSWORD=pw bash deploy/scripts/unlock-accounts.sh
#   sudo ETS_ENV_FILE=/path/to/ets.env bash deploy/scripts/unlock-accounts.sh
#
# تحذير أمني: فكّ القفل عبر هذا السكربت (SQL مباشر) *يتجاوز* سجل التدقيق ولا يُطلق تنبيهات الأمان (S14/S15).
#         الطريقة الأساسية والمُوصى بها هي زر «فكّ القفل» في شاشة الإدارة ← المستخدمون (تُسجَّل بالكامل مع تنبيهاتها)؛
#         لا تستخدم هذا السكربت إلا عند تعذّر الوصول إلى شاشة الإدارة.

set -euo pipefail

# ---- مصدر الاتصال بقاعدة البيانات -------------------------------------------------------------------
# نفس مصدر بقية أدوات النشر (deploy/scripts/backup.sh و deploy/scripts/deploy-lib.sh): المتغيّرات المنفصلة PG*
# في ملف البيئة الذي يكتبه المثبّت فعلاً /etc/ets/ets.env (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD).
# لا يوجد DATABASE_URL في هذا الملف. ما كان مضبوطاً في البيئة مسبقاً له الأولوية (يسمح للمشغّل بتمرير الاتصال صراحةً).
ENVF="${ETS_ENV_FILE:-/etc/ets/ets.env}"

# env_get FILE KEY — قيمة KEY من ملف البيئة (تُزال علامات الاقتباس). تُقرأ كبيانات ولا تُنفَّذ إطلاقاً (لا source/eval)،
# مطابقة لـ env_get في deploy-lib.sh و bk_env_get في backup-lib.sh.
env_get() {
  local v; v=$(sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1)
  v=${v%\'}; v=${v#\'}; v=${v%\"}; v=${v#\"}; printf '%s' "$v"
}

if [[ -r "$ENVF" ]]; then
  for k in PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do
    if [[ -z "${!k:-}" ]]; then
      v="$(env_get "$ENVF" "$k")"
      [[ -n "$v" ]] && export "$k=$v"
    fi
  done
fi

# قاعدة بيانات على خادم آخر تستخدم TLS افتراضياً (مطابق لـ deploy/scripts/backup.sh).
case "${PGHOST:-}" in ''|127.0.0.1|localhost|::1|/*) : ;; *) export PGSSLMODE="${PGSSLMODE:-require}" ;; esac

if [[ -z "${PGDATABASE:-}" ]]; then
  echo "خطأ: لم أجد إعدادات الاتصال بقاعدة البيانات. شغّل السكربت بصلاحية قراءة $ENVF (sudo)،" >&2
  echo "      أو مرّر متغيّرات PG* صراحةً (PGHOST/PGDATABASE/PGUSER/PGPASSWORD)." >&2
  exit 1
fi

# psql يقرأ PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD تلقائياً من البيئة؛ -X لتجاهل ~/.psqlrc.
PSQL=(psql -X -v ON_ERROR_STOP=1)

# ---- تحديد نطاق الحسابات (الكل أو أسماء محدّدة) -------------------------------------------------------
# شرط القفل مطابق لـ services/lockout.js: locked_until موجود وفي المستقبل.
WHERE="locked_until IS NOT NULL AND locked_until > now()"
if [[ $# -gt 0 ]]; then
  # نبني قائمة قيم مقتبسة بأمان عبر psql، مطابقة على username أو email (دون حساسية لحالة الأحرف).
  list=""
  for name in "$@"; do
    esc="${name//\'/\'\'}"            # تهريب علامة الاقتباس المفردة
    list+="${list:+, }lower('$esc')"
  done
  WHERE="$WHERE AND (lower(username) IN ($list) OR lower(email) IN ($list))"
fi

echo "== الحسابات المقفولة حالياً =="
"${PSQL[@]}" -P pager=off -c "
  SELECT id, username, email, failed_attempts,
         to_char(last_failed_at, 'YYYY-MM-DD HH24:MI') AS last_failed,
         to_char(locked_until,   'YYYY-MM-DD HH24:MI') AS locked_until,
         date_trunc('second', locked_until - now())    AS time_left
  FROM users
  WHERE $WHERE
  ORDER BY locked_until DESC;"

CNT="$("${PSQL[@]}" -tA -c "SELECT count(*) FROM users WHERE $WHERE;")"
if [[ "$CNT" -eq 0 ]]; then
  echo "لا يوجد أي حساب مقفول ضمن النطاق المطلوب — لا حاجة لأي إجراء."
  exit 0
fi

echo
read -r -p "فكّ القفل عن $CNT حساب أعلاه؟ اكتب yes للتأكيد: " ans
if [[ "$ans" != "yes" ]]; then
  echo "أُلغيت العملية — لم يتغيّر أي شيء."
  exit 0
fi

# ---- التنفيذ ضمن معاملة واحدة ------------------------------------------------------------------------
"${PSQL[@]}" -c "
  BEGIN;
  UPDATE users
     SET failed_attempts = 0, locked_until = NULL, last_failed_at = NULL
   WHERE $WHERE;
  COMMIT;"

echo "تم فكّ القفل عن $CNT حساب."
