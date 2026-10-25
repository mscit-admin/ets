// Title and body of an alert in the reader's language (Arabic / English), rendered by the server for the bell, the
// history page and the Android app. A row stores only its type, count and parameters (ids, names in both languages,
// numbers); the sentences live here. Security / system alerts never put a user name or an IP address in the title.
import { RATE_CAPPED } from './notify-catalog.js';

// Arabic counted nouns: 1 → «وظيفة واحدة», 2 → «وظيفتان», 3–10 → «5 وظائف», 11+ → «14 وظيفة».
const AR_NOUN = {
  fn: ['وظيفة واحدة', 'وظيفتان', 'وظائف', 'وظيفة'],
  rep: ['تقرير واحد', 'تقريران', 'تقارير', 'تقريراً'],
  item: ['بند واحد', 'بندان', 'بنود', 'بنداً'],
  req: ['طلب واحد', 'طلبان', 'طلبات', 'طلباً'],
  day: ['يوم واحد', 'يومان', 'أيام', 'يوماً'],
  hour: ['ساعة واحدة', 'ساعتان', 'ساعات', 'ساعة'],
  attempt: ['محاولة واحدة', 'محاولتان', 'محاولات', 'محاولة'],
  address: ['عنوان واحد', 'عنوانان', 'عناوين', 'عنواناً'],
  error: ['خطأ واحد', 'خطآن', 'أخطاء', 'خطأً'],
  batch: ['ملف واحد', 'ملفان', 'ملفات', 'ملفاً'],
  alert: ['تنبيه واحد', 'تنبيهان', 'تنبيهات', 'تنبيهاً'],
};
const EN_NOUN = {
  fn: ['function', 'functions'], rep: ['report', 'reports'], item: ['item', 'items'], req: ['request', 'requests'],
  day: ['day', 'days'], hour: ['hour', 'hours'], attempt: ['attempt', 'attempts'], address: ['address', 'addresses'], error: ['error', 'errors'],
  batch: ['file', 'files'], alert: ['alert', 'alerts'],
};
const n0 = v => (Number.isFinite(+v) ? Math.round(+v) : 0);
function ar(n, k) {
  const f = AR_NOUN[k]; n = n0(n);
  if (n === 1) return f[0];
  if (n === 2) return f[1];
  if (n >= 3 && n <= 10) return `${n} ${f[2]}`;
  return `${n} ${f[3]}`;
}
const en = (n, k) => `${n0(n)} ${EN_NOUN[k][n0(n) === 1 ? 0 : 1]}`;
const cnt = (lang, n, k) => (lang === 'ar' ? ar(n, k) : en(n, k));

// functions / reports / items, from p.fn and p.rep (counts by item type, 1.8.0)
function items(lang, p, n) {
  const fn = n0(p.fn), rep = n0(p.rep);
  if (rep && !fn) return cnt(lang, rep, 'rep');
  if (fn && !rep) return cnt(lang, fn, 'fn');
  return cnt(lang, n, 'item');
}
const name = (lang, p, k) => (lang === 'en' ? p[k + '_en'] || p[k + '_ar'] : p[k + '_ar'] || p[k + '_en']) || p[k + '_id'] || '';
const q = (lang, s) => (lang === 'ar' ? `«${s}»` : `“${s}”`);
const pts = v => (Math.round(Math.abs(+v || 0) * 10) / 10).toString();
const STATUS = {
  ar: { on_track: 'ضمن الخطة', at_risk: 'معرّضة للتأخر', delayed: 'متأخرة', done: 'مكتملة', overdue: 'تجاوز موعد الإغلاق', not_started: 'لم يبدأ', no_dates: 'بلا تواريخ' },
  en: { on_track: 'on track', at_risk: 'at risk', delayed: 'delayed', done: 'done', overdue: 'overdue', not_started: 'not started', no_dates: 'no dates' },
};
const PSTATUS = {
  ar: { on_track: 'ضمن الخطة', at_risk: 'معرّض للتأخر', delayed: 'متأخر', done: 'مكتمل', overdue: 'تجاوز موعد الإغلاق', not_started: 'لم يبدأ', no_dates: 'بلا تواريخ' },
  en: STATUS.en,
};
const where = (lang, p) => (p.app_id ? (lang === 'ar' ? `في تطبيق ${name(lang, p, 'app')}` : `in ${name(lang, p, 'app')}`)
  : p.dept_id ? (lang === 'ar' ? `في إدارة ${name(lang, p, 'dept')}` : `in ${name(lang, p, 'dept')}`) : '');

// type → (lang, p, n) → { title, body }
const T = {
  approval_pending: (l, p, n) => (n > 1
    ? { title: l === 'ar' ? `${ar(n, 'req')} تعديل جديدة بانتظار اعتمادك` : `${n} edit requests waiting for your approval`,
      body: l === 'ar' ? `تطبيق ${name(l, p, 'app')}` : name(l, p, 'app') }
    : { title: l === 'ar' ? 'طلب تعديل بانتظار اعتمادك' : 'An edit request is waiting for your approval',
      body: l === 'ar' ? `من: ${p.by_name || '—'} · تطبيق ${name(l, p, 'app')}` : `From: ${p.by_name || '—'} · ${name(l, p, 'app')}` }),
  approval_overdue: (l, p, n) => (p.stage === 'escalate'
    ? { title: l === 'ar' ? `تصعيد: ${ar(n, 'req')} تعديل تنتظر الاعتماد منذ أكثر من ${ar(p.days, 'day')}` : `Escalation: ${en(n, 'req')} waiting for approval for more than ${en(p.days, 'day')}`,
      body: l === 'ar' ? 'افتح صفحة الاعتمادات' : 'Open the approvals page' }
    : { title: l === 'ar' ? `${ar(n, 'req')} تعديل تنتظر اعتمادك منذ أكثر من ${ar(p.hours, 'hour')}` : `${en(n, 'req')} waiting for your approval for more than ${en(p.hours, 'hour')}`,
      body: l === 'ar' ? 'تذكير يومي' : 'Daily reminder' }),
  request_decided: (l, p) => (p.decision === 'applied'
    ? { title: l === 'ar' ? `اعتُمد طلبك رقم ${p.request_id}` : `Your request #${p.request_id} was approved`,
      body: l === 'ar' ? `تطبيق ${name(l, p, 'app')}${p.skipped ? ` · تخطّي ${p.skipped}` : ''}` : `${name(l, p, 'app')}${p.skipped ? ` · ${p.skipped} skipped` : ''}` }
    : { title: l === 'ar' ? `رُفض طلبك رقم ${p.request_id}` : `Your request #${p.request_id} was rejected`,
      body: (l === 'ar' ? `تطبيق ${name(l, p, 'app')}` : name(l, p, 'app')) + (p.reason ? (l === 'ar' ? ` · السبب: ${p.reason}` : ` · Reason: ${p.reason}`) : '') }),
  import_pending: (l, p) => ({
    title: l === 'ar' ? `ملف نتائج رقم ${p.batch_id} بانتظار اعتمادك` : `Result file #${p.batch_id} is waiting for your approval`,
    body: (p.target === 'reports' ? (l === 'ar' ? 'التقارير' : 'Reports') : (l === 'ar' ? `إدارة ${name(l, p, 'dept')}` : name(l, p, 'dept')))
      + (l === 'ar' ? (p.stage === 'final' ? ' · الاعتماد النهائي' : ' · الاعتماد الأول') : (p.stage === 'final' ? ' · final approval' : ' · first approval')) }),
  import_result: (l, p) => {
    const st = { applied: ['طُبّق ملف النتائج رقم', 'Result file #{id} was applied'], rejected: ['رُفض ملف النتائج رقم', 'Result file #{id} was rejected'],
      superseded: ['استُبدل ملف النتائج رقم', 'Result file #{id} was replaced by a newer file'] }[p.status] || ['ملف النتائج رقم', 'Result file #{id}'];
    return { title: l === 'ar' ? `${st[0]} ${p.batch_id}` : st[1].replace('{id}', p.batch_id),
      body: p.status === 'applied' ? (l === 'ar' ? `طُبّق ${p.applied ?? 0} وتُخطّي ${p.skipped ?? 0}` : `${p.applied ?? 0} applied, ${p.skipped ?? 0} skipped`)
        : p.reason ? (l === 'ar' ? `السبب: ${p.reason}` : `Reason: ${p.reason}`) : null };
  },
  import_overdue: (l, p, n) => ({
    title: l === 'ar' ? `${ar(n, 'batch')} نتائج تنتظر توقيعك منذ أكثر من ${ar(p.days, 'day')}` : `${en(n, 'batch')} waiting for your signature for more than ${en(p.days, 'day')}`,
    body: l === 'ar' ? 'افتح صفحة الاستيراد' : 'Open the imports page' }),
  stuck: (l, p, n) => ({
    title: l === 'ar' ? `${items(l, p, n)} ${where(l, p)} بلا تقدّم منذ أكثر من ${ar(p.days, 'day')}` : `${items(l, p, n)} ${where(l, p)} without progress for more than ${en(p.days, 'day')}`,
    body: l === 'ar' ? 'نسبة الإنجاز بين 0% و100% ولم تتغيّر' : 'Progress between 0% and 100% and unchanged' }),
  untested: (l, p, n) => ({
    title: l === 'ar' ? `${items(l, p, n)} ${where(l, p)} بنسبة 100% دون اختبار منذ أكثر من ${ar(p.days, 'day')}` : `${items(l, p, n)} at 100% ${where(l, p)} not tested for more than ${en(p.days, 'day')}`,
    body: l === 'ar' ? 'الإنجاز 100% وحالة الاختبار «لم تُختبر»' : 'Progress 100% and test status “not tested”' }),
  failed_retest: (l, p, n) => ({
    title: l === 'ar' ? `${items(l, p, n)} ${where(l, p)} حالتها «فشل» دون إعادة اختبار منذ أكثر من ${ar(p.days, 'day')}` : `${items(l, p, n)} failed ${where(l, p)} and not tested again for more than ${en(p.days, 'day')}`,
    body: l === 'ar' ? 'حالة الاختبار «فشل»' : 'Test status “failed”' }),
  retest: (l, p, n) => ({
    title: l === 'ar' ? `${items(l, p, n)} ${where(l, p)} تحتاج إعادة اختبار منذ أكثر من ${ar(p.days, 'day')}` : `${items(l, p, n)} ${where(l, p)} need re-testing for more than ${en(p.days, 'day')}`,
    body: l === 'ar' ? 'حالة الاختبار «إعادة الاختبار»' : 'Test status “needs re-testing”' }),
  pass_conflict: (l, p, n) => ({
    title: l === 'ar' ? `${items(l, p, n)} ${where(l, p)} حالتها «نجح» ونسبتها أقل من 100%` : `${items(l, p, n)} ${where(l, p)} passed with progress below 100%`,
    body: l === 'ar' ? 'صحّح النسبة إلى 100% أو غيّر حالة الاختبار' : 'Set the progress to 100% or change the test status' }),
  not_started: (l, p, n) => ({
    title: l === 'ar' ? `${items(l, p, n)} ${where(l, p)} بنسبة 0% بعد مرور ${ar(p.days, 'day')}` : `${items(l, p, n)} ${where(l, p)} not started after ${en(p.days, 'day')}`,
    body: l === 'ar' ? 'نسبة الإنجاز 0%' : 'Progress 0%' }),
  quality: (l, p, n) => ({
    title: l === 'ar' ? `${items(l, p, n)} ${where(l, p)}: إشعار لا يعمل أو مراجعة ناقصة` : `${items(l, p, n)} ${where(l, p)}: notification not working or review missing`,
    body: l === 'ar' ? 'ملخّص أسبوعي' : 'Weekly summary' }),
  excluded: (l, p, n) => ({
    title: l === 'ar' ? `استُبعد أو أزيل ${items(l, p, n)} من تطبيق ${name(l, p, 'app')}` : `${items(l, p, n)} excluded or removed in ${name(l, p, 'app')}`,
    body: p.by_name ? (l === 'ar' ? `بواسطة: ${p.by_name}` : `By: ${p.by_name}`) : null }),
  moved_in: (l, p, n) => ({
    title: l === 'ar' ? `نُقل ${cnt(l, n, 'item')} إلى تطبيق ${name(l, p, 'app')}` : `${en(n, 'item')} moved to ${name(l, p, 'app')}`,
    body: [p.from_app_ar || p.from_app_en ? (l === 'ar' ? `من تطبيق ${name(l, p, 'from_app')}` : `From ${name(l, p, 'from_app')}`) : null,
      p.by_name ? (l === 'ar' ? `بواسطة: ${p.by_name}` : `By: ${p.by_name}`) : null].filter(Boolean).join(' · ') || null }),
  app_moved_in: (l, p) => ({
    title: l === 'ar' ? `نُقل تطبيق ${name(l, p, 'app')} إلى إدارة ${name(l, p, 'to_dept')}` : `${name(l, p, 'app')} moved to ${name(l, p, 'to_dept')}`,
    body: [p.from_dept_ar || p.from_dept_en ? (l === 'ar' ? `من إدارة ${name(l, p, 'from_dept')}` : `From ${name(l, p, 'from_dept')}`) : null,
      p.by_name ? (l === 'ar' ? `بواسطة: ${p.by_name}` : `By: ${p.by_name}`) : null].filter(Boolean).join(' · ') || null }),
  dept_behind: (l, p) => (p.status === 'on_track'
    ? { title: l === 'ar' ? `إدارة ${name(l, p, 'dept')} عادت ضمن الخطة` : `${name(l, p, 'dept')} is back on track`, body: null }
    : { title: l === 'ar' ? `إدارة ${name(l, p, 'dept')} ${STATUS.ar[p.status] || p.status} عن الخطة (−${pts(p.gap)} نقطة)` : `${name(l, p, 'dept')} is ${STATUS.en[p.status] || p.status} (${pts(p.gap)} points behind plan)`,
      body: l === 'ar' ? `الإنجاز ${pts(p.pct)}% والمخطط ${pts(p.planned)}%` : `Actual ${pts(p.pct)}%, planned ${pts(p.planned)}%` }),
  dept_stalled: (l, p) => ({
    title: l === 'ar' ? `إدارة ${name(l, p, 'dept')} شبه متوقفة: تغيّر ${pts(p.change)} نقطة خلال 30 يوماً` : `${name(l, p, 'dept')} has stalled: ${pts(p.change)} points in 30 days`,
    body: l === 'ar' ? `الإنجاز ${pts(p.pct)}%` : `Progress ${pts(p.pct)}%` }),
  project_status: (l, p) => ({
    title: l === 'ar' ? `حالة المشروع: ${PSTATUS.ar[p.to] || p.to}` : `Project status: ${PSTATUS.en[p.to] || p.to}`,
    body: l === 'ar' ? `كانت: ${PSTATUS.ar[p.from] || p.from || '—'}${p.delay_days ? ` · التأخر ${ar(p.delay_days, 'day')}` : ''}` : `Was: ${PSTATUS.en[p.from] || p.from || '—'}${p.delay_days ? ` · delay ${en(p.delay_days, 'day')}` : ''}` }),
  close_approaching: (l, p) => ({
    title: l === 'ar' ? `يبقى ${ar(p.days, 'day')} على موعد إغلاق المشروع` : `${en(p.days, 'day')} left until the project close date`,
    body: l === 'ar' ? `الإنجاز ${pts(p.pct)}%` : `Progress ${pts(p.pct)}%` }),
  account_locked: (l, p, n) => ({
    title: l === 'ar' ? 'حساب أُوقف دخوله مؤقتاً بعد محاولات فاشلة' : 'An account was paused after failed sign-ins',
    body: l === 'ar' ? `الحساب: ${p.username || '—'}${n > 1 ? ` · ${n} مرات` : ''}` : `Account: ${p.username || '—'}${n > 1 ? ` · ${n} times` : ''}` }),
  failed_logins: (l, p, n) => ({
    title: l === 'ar' ? 'محاولات دخول فاشلة كثيرة' : 'Many failed sign-ins',
    body: l === 'ar' ? `${ar(n, 'attempt')} خلال ${p.minutes || 15} دقيقة${p.ip ? ` من ${p.ip}` : ' (كل العناوين)'}` : `${en(n, 'attempt')} in ${p.minutes || 15} minutes${p.ip ? ` from ${p.ip}` : ' (all addresses)'}` }),
  distributed_logins: (l, p, n) => ({
    title: l === 'ar' ? 'نمط محاولات دخول موزّع' : 'Distributed login-probing pattern',
    body: l === 'ar'
      ? `${ar(n, 'attempt')} بمعرّف غير موجود من ${ar(p.ips, 'address')} خلال ${p.minutes || 15} دقيقة — يُحتمل هجوم موزّع لتفادي حدّ المحاولات`
      : `${en(n, 'attempt')} with an unknown user id from ${en(p.ips, 'address')} in ${p.minutes || 15} minutes — likely a distributed attack to evade the per-IP limit` }),
  audit_integrity: (l, p) => ({
    title: l === 'ar' ? 'خلل في سلامة سجلّ التدقيق' : 'Audit log integrity check failed',
    body: l === 'ar' ? `الجداول: ${(p.tables || []).join('، ') || '—'}` : `Tables: ${(p.tables || []).join(', ') || '—'}` }),
  email_index: l => ({
    title: l === 'ar' ? 'الفهرس الفريد للبريد الإلكتروني غير موجود' : 'The unique e-mail index is missing',
    body: l === 'ar' ? 'بعض العناوين مشتركة بين حسابات؛ الدخول بها مرفوض حتى تُصحّح' : 'Some addresses are shared by several accounts; signing in with them is refused until fixed' }),
  access_denied: (l, p, n) => ({
    title: l === 'ar' ? 'محاولات وصول مرفوضة كثيرة' : 'Many refused requests',
    body: l === 'ar' ? `${ar(n, 'attempt')} خلال ساعة` : `${en(n, 'attempt')} in one hour` }),
  backup_missing: (l, p) => ({
    title: l === 'ar' ? `لا توجد نسخة احتياطية منذ أكثر من ${ar(p.hours, 'hour')}` : `No database backup for more than ${en(p.hours, 'hour')}`,
    body: p.last ? (l === 'ar' ? `آخر نسخة: ${String(p.last).slice(0, 16).replace('T', ' ')}` : `Last backup: ${String(p.last).slice(0, 16).replace('T', ' ')}`)
      : (l === 'ar' ? 'لم تُسجَّل أي نسخة' : 'No backup recorded') }),
  backup_offsite: (l, p) => {
    const d = { ar: { ssh: 'الخادم البعيد (SSH)', nas: 'وحدة التخزين الشبكية (NAS)', cloud: 'التخزين السحابي' }, en: { ssh: 'remote server (SSH)', nas: 'NAS', cloud: 'cloud storage' } }[l][p.dest] || p.dest;
    return { title: l === 'ar' ? `النسخة الخارجية متأخرة أو فشلت: ${d}` : `Offsite copy late or failing: ${d}`,
      body: (p.last_ok ? (l === 'ar' ? `آخر نسخة ناجحة: ${String(p.last_ok).slice(0, 16).replace('T', ' ')}` : `Last good copy: ${String(p.last_ok).slice(0, 16).replace('T', ' ')}`)
        : (l === 'ar' ? 'لم تنجح أي نسخة بعد' : 'No successful copy yet')) + (p.error ? ` · ${String(p.error).slice(0, 120)}` : '') };
  },
  backup_verify: (l, p) => (p.stage === 'stale'
    ? { title: l === 'ar' ? `لم ينجح اختبار الاسترجاع منذ أكثر من ${ar(p.days, 'day')}` : `No successful test restore for more than ${en(p.days, 'day')}`,
      body: l === 'ar' ? 'شغّل «تحقق الآن» من الإعدادات ← النسخ الاحتياطي' : 'Run «Verify now» in Settings → Backups' }
    : { title: l === 'ar' ? 'فشل اختبار الاسترجاع الأسبوعي للنسخة الاحتياطية' : 'The weekly test restore of the backup failed',
      body: p.error ? String(p.error).slice(0, 160) : null }),
  restore_event: (l, p) => {
    const st = { started: ['بدأ استرجاع من نسخة احتياطية', 'A restore from a backup started'], done: ['اكتمل الاسترجاع من النسخة الاحتياطية', 'The restore from a backup finished'],
      rolled_back: ['فشل الاسترجاع وأُعيد النظام إلى حالته السابقة', 'The restore failed and was rolled back'],
      failed: ['فشل الاسترجاع من النسخة الاحتياطية', 'The restore from a backup failed'] }[p.stage] || ['استرجاع من نسخة احتياطية', 'Restore from a backup'];
    return { title: l === 'ar' ? st[0] : st[1],
      body: [p.by ? (l === 'ar' ? `بواسطة: ${p.by}` : `By: ${p.by}`) : null, p.created ? (l === 'ar' ? `نسخة: ${String(p.created).slice(0, 16).replace('T', ' ')}` : `Backup: ${String(p.created).slice(0, 16).replace('T', ' ')}`) : null]
        .filter(Boolean).join(' · ') || null };
  },
  release_event: (l, p) => {
    const roll = p.intent === 'rollback';
    const st = {
      started: roll ? ['بدأ تراجع الإنتاج إلى إصدار سابق', 'A production rollback started']
        : ['بدأت ترقية الإنتاج', 'A production promotion started'],
      succeeded: roll ? ['اكتمل تراجع الإنتاج بنجاح', 'The production rollback succeeded']
        : ['نجحت ترقية الإنتاج', 'The production promotion succeeded'],
      failed: ['فشلت ترقية الإنتاج', 'The production deploy failed'],
      rolled_back: ['فشل النشر وتم التراجع إلى الإصدار السابق', 'The deploy failed and was rolled back'],
    }[p.stage] || ['حدث في نشر الإنتاج', 'Production deploy event'];
    const needsRestore = p.stage === 'failed' && p.needs_db_restore;
    return {
      title: l === 'ar' ? st[0] : st[1],
      body: [
        p.version ? (l === 'ar' ? `الإصدار ${p.version}` : `version ${p.version}`) : null,
        p.by ? (l === 'ar' ? `بواسطة: ${p.by}` : `by ${p.by}`) : null,
        needsRestore ? (l === 'ar' ? `يلزم استرجاع قاعدة البيانات: ${p.restore_command || 'ets-restore <backup_ref>'}`
          : `DB restore required: ${p.restore_command || 'ets-restore <backup_ref>'}`) : null,
        !needsRestore && p.error ? String(p.error).slice(0, 160) : null,
      ].filter(Boolean).join(' · ') || null,
    };
  },
  message_received: (l, p) => ({
    title: l === 'ar' ? `رسالة جديدة من ${p.from_name || '—'}` : `New message from ${p.from_name || '—'}`,
    body: p.subject ? (l === 'ar' ? p.subject : p.subject) : (p.preview || null) }),
  message_reply: (l, p) => ({
    title: l === 'ar' ? `رد جديد من ${p.from_name || '—'}` : `New reply from ${p.from_name || '—'}`,
    body: p.subject ? (l === 'ar' ? p.subject : p.subject) : (p.preview || null) }),
  retention_reduced: (l, p) => ({
    title: l === 'ar' ? 'خُفّضت مدة الاحتفاظ بالسجلات' : 'Log retention was reduced',
    body: `${p.key}: ${p.from} → ${p.to}${p.by ? (l === 'ar' ? ` · بواسطة ${p.by}` : ` · by ${p.by}`) : ''}` }),
  server_errors: (l, p, n) => ({
    title: l === 'ar' ? 'أخطاء كثيرة في الخادم' : 'Many server errors',
    body: l === 'ar' ? `${ar(n, 'error')} خلال ساعة` : `${en(n, 'error')} in one hour` }),
  [RATE_CAPPED]: (l, p, n) => ({
    title: l === 'ar' ? 'وصلتك تنبيهات كثيرة — افتح صفحة التنبيهات' : 'Many alerts arrived — open the notifications page',
    body: l === 'ar' ? `${ar(n, 'alert')} لم تُعرض منفردة خلال الساعة الأخيرة` : `${en(n, 'alert')} not shown one by one in the last hour` }),
};

export const GENERIC = {
  ar: { title: 'لديك تنبيه جديد', body: 'افتح ETS لعرضه' },
  en: { title: 'You have a new alert', body: 'Open ETS to see it' },
};

// row: { type, count, params } → { title, body }
export function render(row, lang = 'ar') {
  const l = lang === 'en' ? 'en' : 'ar';
  const f = Object.hasOwn(T, row.type) ? T[row.type] : null;
  if (!f) return { ...GENERIC[l] };
  const p = row.params || {};
  const out = f(l, p, n0(p.n ?? row.count ?? 1));
  return { title: String(out.title).replace(/\s+/g, ' ').trim(), body: out.body == null ? null : String(out.body).replace(/\s+/g, ' ').trim() };
}

export const quote = q;
