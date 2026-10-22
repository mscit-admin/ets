// ETS maintenance page (1.12.0): progress of a restore, read from /api/restore-status.json (served by nginx, no secrets).
// A separate file because the Content-Security-Policy (script-src 'self') forbids inline scripts.
(function () {
  var L = { fetch: 'جلب الملفات', checksum: 'التحقق من المجاميع', decrypt: 'فك التشفير', safety: 'نسخة أمان من الحالة الحالية', stop: 'إيقاف النظام',
    restore_data: 'استرجاع البيانات', restore_index: 'الفهارس والقيود', config: 'ملفات الإعدادات', migrate: 'الترحيلات', verify: 'فحص سلسلة التدقيق',
    start: 'تشغيل النظام', health: 'فحص الاستجابة', logs: 'السجلات النصية' };
  var S = { running: 'جارٍ', done: 'اكتمل', failed: 'فشل', rolling_back: 'جارٍ التراجع', rolled_back: 'أُعيد إلى ما كان', rollback_failed: 'فشل التراجع' };
  var C = { running: '', done: 'ok', failed: 'bad', rolling_back: 'warn', rolled_back: 'warn', rollback_failed: 'bad' };
  var nf = new Intl.NumberFormat('en-US');
  function dur(s) { s = Math.max(0, Math.round(s || 0)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return h ? h + ' س ' + m + ' د' : m ? m + ' د ' + r + ' ث' : r + ' ث'; }
  function size(n) { var u = ['بايت', 'ك.ب', 'م.ب', 'ج.ب', 'ت.ب'], i = 0; n = +n || 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }
  function el(id) { return document.getElementById(id); }
  function draw(s) {
    var st = s.state || 'running', c = s.counters || {}, m = [];
    el('st').textContent = S[st] || st;
    el('pct').textContent = (+s.percent || 0).toFixed(1) + '%';
    el('fill').style.width = Math.min(100, +s.percent || 0) + '%';
    el('bar').className = 'bar ' + (C[st] || '');
    if (st === 'running' || st === 'rolling_back') m.push('الوقت المتبقي تقريباً: ' + dur(s.eta_s) + (s.eta_estimated ? ' (تقديري)' : ''));
    m.push('الوقت المنقضي: ' + dur(s.elapsed_s));
    if (c.bytes && c.bytes.total) m.push('المُعالَج: ' + size(c.bytes.done) + ' من ' + size(c.bytes.total) + ' — المتبقي ' + size(c.bytes.total - c.bytes.done));
    if (c.tables && c.tables.total) m.push('الجداول: ' + nf.format(c.tables.done) + ' من ' + nf.format(c.tables.total));
    if (c.rows && c.rows.total) m.push('السجلات: ' + nf.format(c.rows.done) + ' من ' + nf.format(c.rows.total) + ' — المتبقي ' + nf.format(c.rows.total - c.rows.done));
    el('meta').innerHTML = ''; m.forEach(function (x) { var sp = document.createElement('span'); sp.textContent = x; el('meta').appendChild(sp); });
    el('steps').innerHTML = '';
    (s.phases || []).forEach(function (p) {
      if (p.state === 'skipped') return;
      var li = document.createElement('li'); li.className = p.state;
      li.textContent = (p.state === 'done' ? '✓ ' : p.state === 'failed' ? '✕ ' : p.state === 'running' ? '● ' : '○ ') + (L[p.key] || p.key);
      el('steps').appendChild(li);
    });
    el('msg').textContent = st === 'done' ? 'اكتمل الاسترجاع. جارٍ فتح صفحة الدخول…' : st === 'rolled_back' ? 'فشل الاسترجاع وأُعيد النظام إلى حالته السابقة.' : st === 'rollback_failed' ? 'فشل الاسترجاع والتراجع: راجع دليل التشغيل.' : '';
    if (st === 'done' || st === 'rolled_back') setTimeout(function () { location.href = '/'; }, 4000);
  }
  function tick() {
    fetch('/api/restore-status.json', { headers: { 'X-ETS-Status': '1' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (s) { if (s) draw(s); })
      .catch(function () {}).then(function () { setTimeout(tick, 1000); });
  }
  tick();
})();
