// Aggregated HelpBot explanation strings, merged into the i18n dictionary in i18n/index.jsx.
// Each area file is owned by one coverage pass; keys are referenced from pages via data-help / data-help-title.
import { overview } from './overview.js';
import { departments } from './departments.js';
import { people } from './people.js';
import { workflow } from './workflow.js';
import { settings } from './settings.js';

export const helpMessages = {
  ar: { ...overview.ar, ...departments.ar, ...people.ar, ...workflow.ar, ...settings.ar },
  en: { ...overview.en, ...departments.en, ...people.en, ...workflow.en, ...settings.en },
};
