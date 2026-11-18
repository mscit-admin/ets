// Help-assistant explanations (HelpBot). Keys referenced by data-help on the pages this file covers.
export const departments = {
  ar: {
    // Department page
    hb_dept_head: 'صفحة الإدارة تعرض جميع تطبيقاتها ونسبة إنجازها الإجمالية ووزنها في المشروع. استخدم أزرار التصدير لإخراج تفاصيل الإدارة أو وظائفها كملف.',
    hb_dept_apps: 'قائمة تطبيقات هذه الإدارة. يُظهر كل صف عدد الوظائف وحالة الاختبارات والوزن ونسبة الإنجاز. اضغط اسم التطبيق للانتقال إلى صفحته التفصيلية.',
    hb_dept_apps_t: 'تطبيقات الإدارة',

    // Application page
    hb_app_head: 'صفحة التطبيق تعرض وظائفه وتتيح تحديث نسب الإنجاز وحالات الاختبار. تجد في الأعلى أدوات التعديل الجماعي ونقل التطبيق وإضافة وظيفة وتصدير البيانات.',
    hb_app_pct: 'يوضح هذا الشريط كيفية احتساب نسبة إنجاز التطبيق من أوزان الوظائف والتقارير. يبقى ظاهراً في الأعلى أثناء التمرير لمتابعة النتيجة الإجمالية.',
    hb_app_pct_t: 'معادلة نسبة الإنجاز',
    hb_app_filter: 'أدوات تصفية وبحث الوظائف حسب المصدر والنوع وحالة الاختبار وسبب التعطيل. يمكنك أيضاً إظهار الوظائف المعطّلة أو المحذوفة.',
    hb_app_filter_t: 'تصفية الوظائف',
    hb_app_table: 'جدول وظائف التطبيق. يعرض كل صف الوزن ونسبة الإنجاز وحالات الاختبار والإشعار والمراجعة مع إمكانية التعديل المباشر والملاحظات والإجراءات.',
    hb_app_table_t: 'جدول الوظائف',
    hb_app_bulk: 'تعديل جماعي يطبّق تغييراً واحداً على عدة وظائف دفعة واحدة، مثل الوزن أو حالة الاختبار أو التفعيل.',
    hb_app_move: 'نقل التطبيق بأكمله إلى إدارة أخرى مع تسجيل سبب النقل في سجل التطبيق.',
    hb_app_add: 'إضافة وظيفة جديدة إلى هذا التطبيق. قد تحتاج الإضافة إلى موافقة قائد الفريق قبل اعتمادها.',

    // Reports page
    hb_reports_head: 'صفحة التقارير تتابع تقدّم بند التقارير لكل تطبيق عبر الإدارات. استخدم زر التصدير لإخراج الحالة كملف.',
    hb_reports_progress: 'متوسط إنجاز التقارير مرجّحاً بأوزان التطبيقات، مع حصة بند التقارير من نسبة الإنجاز الكلية للتطبيق.',
    hb_reports_status: 'عدد التطبيقات في كل حالة من حالات التقارير، لإعطاء صورة سريعة عن توزّع التقدّم.',
    hb_reports_table: 'جدول تقارير هذه الإدارة. يعرض لكل تطبيق حالة التقرير ونسبة إنجازه وعدد بنوده وملاحظاته، مع زر التعديل عند توفّر الصلاحية.',

    // Online users page
    hb_online_head: 'صفحة المستخدمين المتصلين الآن تعرض من يستخدم النظام وعلى أي شاشة ومنذ متى. تتحدّث البيانات تلقائياً كل خمس عشرة ثانية.',
    hb_online_stat_online: 'عدد الجلسات النشطة المتصلة في هذه اللحظة.',
    hb_online_stat_idle: 'عدد الجلسات الخاملة التي لم يسجَّل فيها نشاط منذ فترة رغم بقائها مفتوحة.',
    hb_online_stat_sessions: 'إجمالي الجلسات المفتوحة وعدد المستخدمين المختلفين الذين تخصّهم.',
    hb_online_list: 'قائمة الجلسات المتصلة. يعرض كل صف المستخدم وحالته والشاشة التي يتصفّحها ومدة الجلسة وآخر نشاط والعميل وعنوان الإنترنت.',
    hb_online_list_t: 'الجلسات المتصلة',
    hb_online_filter: 'تصفية الجلسات حسب الدور أو الإدارة أو الشاشة الحالية لتضييق القائمة المعروضة.',
    hb_online_filter_t: 'تصفية الجلسات',
    hb_online_end: 'إنهاء جلسة هذا المستخدم فوراً وتسجيل خروجه من النظام. يُستخدم لإغلاق جلسة غير مرغوبة.',
  },
  en: {
    // Department page
    hb_dept_head: 'The department page shows all of its applications, overall progress, and its weight within the project. Use the export buttons to download the department details or its functions as a file.',
    hb_dept_apps: 'The list of this department\'s applications. Each row shows the number of functions, test status, weight, and progress. Click an application name to open its detailed page.',
    hb_dept_apps_t: 'Department applications',

    // Application page
    hb_app_head: 'The application page lists its functions and lets you update progress and test statuses. The header holds the bulk-edit, move-application, add-function, and export controls.',
    hb_app_pct: 'This bar explains how the application\'s progress is calculated from the weights of its functions and reports. It stays pinned at the top as you scroll so the overall result remains visible.',
    hb_app_pct_t: 'Progress breakdown',
    hb_app_filter: 'Controls for searching and filtering functions by source, type, test status, and disable reason. You can also reveal disabled or removed functions.',
    hb_app_filter_t: 'Filter functions',
    hb_app_table: 'The application\'s functions table. Each row shows weight, progress, and the test, notification, and review statuses, with inline editing, notes, and row actions.',
    hb_app_table_t: 'Functions table',
    hb_app_bulk: 'Bulk edit applies a single change to several functions at once, such as weight, test status, or inclusion.',
    hb_app_move: 'Move the whole application to another department, recording the reason in the application\'s history.',
    hb_app_add: 'Add a new function to this application. The addition may require team-lead approval before it takes effect.',

    // Reports page
    hb_reports_head: 'The reports page tracks the reports item\'s progress for every application across departments. Use the export button to download the current status as a file.',
    hb_reports_progress: 'Average report progress weighted by application weight, alongside the reports item\'s share of each application\'s overall progress.',
    hb_reports_status: 'The number of applications in each report status, giving a quick picture of how progress is spread.',
    hb_reports_table: 'This department\'s reports table. For each application it shows the report status, its progress, item count, and notes, with an edit button where permitted.',

    // Online users page
    hb_online_head: 'The online-users page shows who is using the system right now, on which screen, and since when. The data refreshes automatically every fifteen seconds.',
    hb_online_stat_online: 'The number of active sessions connected at this moment.',
    hb_online_stat_idle: 'The number of idle sessions that remain open but have had no recorded activity for a while.',
    hb_online_stat_sessions: 'The total number of open sessions and how many distinct users they belong to.',
    hb_online_list: 'The list of connected sessions. Each row shows the user, their status, the screen they are viewing, session length, last activity, client, and IP address.',
    hb_online_list_t: 'Connected sessions',
    hb_online_filter: 'Filter the sessions by role, department, or current screen to narrow the displayed list.',
    hb_online_filter_t: 'Filter sessions',
    hb_online_end: 'End this user\'s session immediately and sign them out of the system. Use it to close an unwanted session.',
  },
};
