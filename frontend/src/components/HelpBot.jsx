import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';

// HelpBot — a floating "professor robot" help assistant present on every screen (mounted once in Layout).
// Click the robot to arm "explain mode": the next click on any part of the system is intercepted (no navigation),
// the nearest element carrying data-help is resolved to a detailed explanation, and the robot FLIES next to that
// element and shows the explanation in a bubble beside it. Stays armed so the user can keep clicking different
// parts; Esc or clicking the robot again exits and the robot flies home. Elements opt in with
// data-help="<i18n body key>" and optional data-help-title="<i18n title key>" (see Card / NumberCard / PageHeader
// in ui.jsx); untagged elements get a friendly fallback (shown at home).

const BOT = 60; const GAP = 14; const MARGIN = 8;

// Where the robot should fly for an element, and which way its bubble opens. Pure geometry on the element's
// on-screen rectangle; everything is clamped into the viewport so the robot and bubble never leave the screen.
function placeFor(rect) {
  const vw = window.innerWidth, vh = window.innerHeight;
  let top = Math.min(Math.max(rect.top + rect.height / 2 - BOT / 2, MARGIN), vh - BOT - MARGIN);
  let left;
  if (vw - rect.right >= BOT + GAP + 24) left = rect.right + GAP;            // robot to the inline-right of the element
  else if (rect.left >= BOT + GAP + 24) left = rect.left - BOT - GAP;        // robot to the inline-left
  else {                                                                      // no room beside it → below, else above
    left = rect.left + rect.width / 2 - BOT / 2;
    top = rect.bottom + GAP + BOT < vh ? rect.bottom + GAP : Math.max(MARGIN, rect.top - GAP - BOT);
  }
  left = Math.min(Math.max(left, MARGIN), vw - BOT - MARGIN);
  const cx = left + BOT / 2;
  return { top, left, side: cx > vw / 2 ? 'left' : 'right', vert: top < vh / 2 ? 'down' : 'up' };
}

function ProfessorBot() {
  return (
    <svg className="hb-bot" viewBox="0 0 72 72" width="46" height="46" aria-hidden="true" focusable="false">
      <g className="hb-pointer">
        <line x1="50" y1="52" x2="68" y2="26" stroke="#8a5a2b" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="68" cy="26" r="3.2" fill="#f4b740" stroke="#c88a1e" strokeWidth="1" />
      </g>
      <line x1="36" y1="10" x2="36" y2="3" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="36" cy="3.4" r="2.6" fill="#f4b740" />
      <rect x="16" y="10" width="40" height="32" rx="11" fill="#eef3fb" stroke="currentColor" strokeWidth="2.4" />
      <rect x="11" y="20" width="5" height="11" rx="2.2" fill="currentColor" />
      <rect x="56" y="20" width="5" height="11" rx="2.2" fill="currentColor" />
      <g className="hb-glasses" fill="none" stroke="currentColor" strokeWidth="2.4">
        <circle cx="28" cy="26" r="7" fill="#ffffff" />
        <circle cx="44" cy="26" r="7" fill="#ffffff" />
        <line x1="35" y1="26" x2="37" y2="26" />
      </g>
      <circle cx="28" cy="26" r="2.6" fill="#1f3b6e" />
      <circle cx="44" cy="26" r="2.6" fill="#1f3b6e" />
      <path d="M29 35 q7 5 14 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <g className="hb-cap">
        <polygon points="36,2 58,11 36,20 14,11" fill="#1f3b6e" />
        <rect x="33.5" y="13" width="5" height="7" fill="#1f3b6e" />
        <line x1="58" y1="11" x2="58" y2="19" stroke="#f4b740" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="58" cy="20" r="2" fill="#f4b740" />
      </g>
      <rect x="22" y="44" width="28" height="18" rx="7" fill="#dbe6fa" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="31" cy="53" r="2" fill="currentColor" />
      <circle cx="41" cy="53" r="2" fill="currentColor" />
    </svg>
  );
}

export function HelpBot() {
  const { t, dir } = useI18n();
  const [armed, setArmed] = useState(false);
  const [bubble, setBubble] = useState(null);   // { title, body } | 'hint' | null
  const [fly, setFly] = useState(null);         // { top, left, side, vert } | null  (null = home corner)
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const rootRef = useRef(null);
  const targetRef = useRef(null);               // the element currently being explained (for reposition on scroll)

  useEffect(() => {
    const r = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);

  const clearTarget = useCallback(() => {
    if (targetRef.current) { targetRef.current.classList.remove('hb-explained'); targetRef.current = null; }
  }, []);
  const stop = useCallback(() => { setArmed(false); setBubble(null); setFly(null); clearTarget(); }, [clearTarget]);

  const explain = useCallback(el => {
    const bodyKey = el.getAttribute('data-help');
    const titleKey = el.getAttribute('data-help-title');
    const title = titleKey ? t(titleKey)
      : (el.querySelector('h1,h2,h3,.nc-label,.card-head h3,span')?.textContent?.trim() || t('hb_default_title'));
    clearTarget();
    targetRef.current = el; el.classList.add('hb-explained');
    setBubble({ title, body: t(bodyKey) });
    setFly(placeFor(el.getBoundingClientRect()));
  }, [t, clearTarget]);

  // While armed, intercept the next click anywhere (capture phase) and turn it into an explanation.
  useEffect(() => {
    if (!armed) return undefined;
    document.body.classList.add('hb-arming');
    const onClick = e => {
      if (rootRef.current && rootRef.current.contains(e.target)) return;   // clicks on the bot / bubble pass through
      e.preventDefault(); e.stopPropagation();
      const el = e.target.closest?.('[data-help]');
      if (el) explain(el);
      else { clearTarget(); setFly(null); setBubble({ title: t('hb_none_t'), body: t('hb_none_d') }); }
    };
    const onKey = e => { if (e.key === 'Escape') stop(); };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.body.classList.remove('hb-arming');
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [armed, t, stop, explain, clearTarget]);

  // Keep the robot beside its element while the page scrolls or resizes.
  useEffect(() => {
    if (!fly || !targetRef.current) return undefined;
    const reposition = () => {
      if (!targetRef.current?.isConnected) { stop(); return; }
      setFly(placeFor(targetRef.current.getBoundingClientRect()));
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); };
  }, [fly, stop]);

  const toggle = () => {
    if (armed) { stop(); return; }
    setArmed(true); setBubble('hint'); setFly(null);
  };

  // Home corner: bottom, on the inline-end side (right in LTR, left in RTL). Both home and flight use top/left so
  // the robot glides smoothly between them (CSS transition).
  const home = { top: vp.h - BOT - 20, left: dir === 'rtl' ? 20 : vp.w - BOT - 20 };
  const pos = fly || home;
  const posStyle = { top: pos.top + 'px', left: pos.left + 'px' };
  const bubbleCls = fly ? ` hb-at hb-${fly.side} hb-${fly.vert}` : ' hb-home';

  return (
    <div className={'help-bot' + (armed ? ' armed' : '') + (fly ? ' flying' : '')} ref={rootRef} style={posStyle}>
      {bubble && (
        <div className={'hb-bubble' + bubbleCls} role="dialog" aria-live="polite" aria-label={t('hb_title')}>
          <button className="hb-close" onClick={stop} aria-label={t('close')}>×</button>
          {bubble === 'hint' ? (
            <>
              <b className="hb-bubble-title">{t('hb_title')}</b>
              <p>{t('hb_arm_hint')}</p>
            </>
          ) : (
            <>
              <b className="hb-bubble-title">{bubble.title}</b>
              <p>{bubble.body}</p>
              <div className="hb-tip">{t('hb_tip')}</div>
            </>
          )}
        </div>
      )}
      <button type="button" className="hb-trigger" onClick={toggle} aria-pressed={armed}
        aria-label={t('hb_title')} title={t('hb_title')}>
        <ProfessorBot />
      </button>
    </div>
  );
}
