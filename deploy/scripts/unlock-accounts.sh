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
#   DATABASE_URL=postgres://ets:pw@127.0.0.1/ets bash deploy/scripts/unlock-accounts.sh
#
# ملاحظة: فكّ القفل عبر هذا السكربت (SQL مباشر) لا يُسجَّل في سجل التدقيق ولا يُطلق تنبيهات S14/S15؛
#         إن أردت التوثيق الكامل استخدم زر «فكّ القفل» في شاشة الإدارة ← المستخدمون.

set -euo pipefail

# ---- مصدر الاتصال بقاعدة البيانات -------------------------------------------------------------------
# يُفضَّل DATABASE_URL (نفس ما يستخدمه التطبيق). إن لم يُضبط، نحاول قراءته من /opt/ets/.env ثم backend/.env.
DB_URL="${DATABASE_URL:-}"
if [[ -z "$DB_URL" ]]; then
  for f in /opt/ets/.env /opt/ets/backend/.env "$(dirname "$0")/../../backend/.env" "$(dirname "$0")/../../.env"; do
    if [[ -f "$f" ]]; then
      line="$(grep -E '^DATABASE_URL=' "$f" | tail -n1 || true)"
      if [[ -n "$line" ]]; then DB_URL="${line#DATABASE_URL=}"; DB_URL="${DB_URL%\"}"; DB_URL="${DB_URL#\"}"; break; fi
    fi
  done
fi
if [[ -z "$DB_URL" ]]; then
  echo "خطأ: لم أجد DATABASE_URL. مرّره في البيئة أو تأكّد من وجوده في /opt/ets/.env" >&2
  exit 1
fi

PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1)

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
