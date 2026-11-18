import { useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { Icon } from './Icon.jsx';

// A small "how is this computed?" note: an info (ⓘ) button that toggles an inline explanation of the project
// progress formula. Used on the project-phases settings tab and on the dashboard project card, so the explanation
// lives in one place. It returns the button and the note as siblings (a fragment): the note is an ordinary block
// that wraps onto its own row (flex-basis:100% in a flex row, full width in a block), so it never clips or overlaps.
export function FormulaNote() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn-icon btn-xs formula-btn" aria-expanded={open}
        aria-label={t('formula_note_title')} title={t('formula_note_title')} onClick={() => setOpen(o => !o)}>
        <Icon name="info" size={15} />
      </button>
      {open && (
        <div className="formula-note" role="note">
          <b>{t('formula_note_title')}</b>
          <ul>
            <li>{t('formula_note_1')}</li>
            <li>{t('formula_note_2')}</li>
            <li>{t('formula_note_3')}</li>
          </ul>
        </div>
      )}
    </>
  );
}
