// Help-assistant explanations (HelpBot). Keys referenced by data-help on the pages this file covers.
export const overview = {
  ar: {
    // Dashboard (الرئيسية)
    hb_dash_head: 'الشاشة الرئيسية التي تعرض نظرة شاملة على تقدّم النظام والمشروع، مع التنبيهات المعلّقة وأهمّ المؤشرات والرسوم البيانية.',
    hb_dash_export: 'تصدير ملخّص هذه الشاشة إلى ملف Excel وفق لغتك وصلاحياتك الحالية.',
    hb_dash_export_fn: 'تصدير وظائف جميع التطبيقات في ملف Excel واحد.',
    hb_dash_erp: 'يعرض نسبة الإنجاز الكلية للنظام والمشروع موزّعةً على الوحدات والمراحل، ويُحدَّث مباشرةً عند تغيير أيّ مستخدم للبيانات.',
    hb_dash_sys: 'عجلة النظام: نسبة إنجاز وحدات تخطيط الموارد النشطة ونسبة الوظائف وحدها، مع قائمة بالوحدات وروابط إلى كلّ إدارة.',
    hb_dash_proj: 'عجلة المشروع: نسبة الإنجاز الموزونة حسب مراحل المشروع، مع بيان وزن كلّ مرحلة ومساهمتها في الإجمالي.',
    hb_dash_stats: 'أرقام مجمّعة: عدد الوظائف المحتسبة، والمكتملة، والمختبَرة بنجاح، وتلك التي عليها ملاحظات.',
    hb_dash_schedule: 'ملخّص منحنى الإنجاز وحالة المشروع مقارنةً بالخطة، مع توقّع تاريخ الانتهاء ورابط إلى صفحة الحالة.',
    hb_dash_lowest: 'أقلّ خمسة تطبيقات من حيث نسبة الإنجاز، للمساعدة في تحديد ما يحتاج إلى متابعة.',
    hb_dash_tests: 'توزيع حالات الاختبار على جميع الوظائف، موضَّحًا بشريط وبمفتاح ألوان لكلّ حالة.',

    // Weights (الأوزان)
    hb_weights_head: 'صفحة أوزان التطبيقات التي تتحكّم في مدى تأثير كلّ تطبيق في نسبة الإنجاز الكلية.',
    hb_weights_export: 'تصدير جدول الأوزان إلى ملف Excel.',
    hb_weights_reset: 'إعادة جميع الأوزان إلى قيمها الافتراضية (متاح لأصحاب الصلاحية العامة فقط).',
    hb_weights_save: 'حفظ تعديلاتك على الأوزان والإعدادات.',
    hb_weights_calc: 'إعدادات طريقة الحساب: وضع الوزن (ثابت أو تلقائي) وحصّتا الإشعارات والتقارير من الإجمالي.',
    hb_weights_table: 'أوزان تطبيقات هذه الإدارة: الوزن الافتراضي، ومجموع أوزان الوظائف، والوزن المعتمَد، وحصّة كلّ تطبيق من الإجمالي.',

    // Schedule (الجدول الزمني)
    hb_sched_head: 'صفحة الجدول الزمني ومنحنى الإنجاز التراكمي المخطَّط مقابل الفعلي عبر فترات المشروع.',
    hb_sched_export: 'تصدير بيانات الجدول الزمني إلى ملف Excel.',
    hb_sched_save: 'حفظ تعديلات الجدول الزمني والخطة والقيم الفعلية.',
    hb_sched_curve: 'منحنى S الذي يقارن الإنجاز المخطَّط بالفعلي، مع مؤشرات أداء الجدول الزمني أعلاه.',
    hb_sched_details: 'تفاصيل الجدول: تاريخ البدء وعدد الفترات ووحدتها، وجدول لإدخال النسب المخطَّطة والفعلية لكلّ فترة.',
    hb_sched_table: 'جدول الفترات: النسبة المخطَّطة والفعلية والانحراف بينهما لكلّ فترة، مع إبراز الفترة الحالية.',

    // Search (البحث)
    hb_search_head: 'صفحة نتائج البحث عن الوظائف عبر جميع التطبيقات بحسب العبارة المُدخَلة.',
    hb_search_table: 'نتائج البحث: اسم الوظيفة ونوعها ورمزها ومصدرها، والتطبيق التابعة له، ونسبة إنجازها.',
  },
  en: {
    // Dashboard
    hb_dash_head: 'The home screen giving an overall view of system and project progress, with pending notices and the key indicators and charts.',
    hb_dash_export: 'Export a summary of this screen to an Excel file, in your current language and scope.',
    hb_dash_export_fn: 'Export the functions of all applications into a single Excel file.',
    hb_dash_erp: 'Shows overall completion for the system and the project, broken down by modules and phases, and updates live whenever any user changes the data.',
    hb_dash_sys: 'The system wheel: completion of the active ERP modules and the functions-only figure, with a list of modules linking to each department.',
    hb_dash_proj: 'The project wheel: completion weighted across the project phases, showing each phase weight and its contribution to the total.',
    hb_dash_stats: 'Summary counts: functions counted, completed, successfully tested, and those with notes.',
    hb_dash_schedule: 'A summary of the progress curve and project health against plan, with the forecast end date and a link to the status page.',
    hb_dash_lowest: 'The five lowest applications by completion, to help spot what needs follow-up.',
    hb_dash_tests: 'The distribution of test statuses across all functions, shown as a bar with a colour legend for each status.',

    // Weights
    hb_weights_head: 'The application weights page, which controls how much each application affects the overall completion.',
    hb_weights_export: 'Export the weights table to an Excel file.',
    hb_weights_reset: 'Reset all weights to their default values (available to global-scope users only).',
    hb_weights_save: 'Save your changes to the weights and settings.',
    hb_weights_calc: 'Calculation settings: the weight mode (fixed or automatic) and the notifications and reports shares of the total.',
    hb_weights_table: "Weights for this department's applications: the default weight, the sum of function weights, the applied weight, and each application's share of the total.",

    // Schedule
    hb_sched_head: 'The schedule page: the planned-versus-actual cumulative progress curve across the project periods.',
    hb_sched_export: 'Export the schedule data to an Excel file.',
    hb_sched_save: 'Save changes to the schedule, the plan, and the actual values.',
    hb_sched_curve: 'The S-curve comparing planned and actual progress, with the schedule performance indicators shown above it.',
    hb_sched_details: 'Schedule details: start date, number of periods and their unit, and a table for entering the planned and actual percentages per period.',
    hb_sched_table: 'The periods table: the planned and actual percentage and the deviation between them for each period, with the current period highlighted.',

    // Search
    hb_search_head: 'The search results page, listing functions across all applications that match the query entered.',
    hb_search_table: "The search results: each function's name, type, code and source, the application it belongs to, and its completion percentage.",
  },
};
