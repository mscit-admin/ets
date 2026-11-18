// Project phases progress — a manual, weighted model of the project's delivery phases, stored as the settings value
// `project.phases` (an array of phase objects). It sits ALONGSIDE the function-level system roll-up (services/calc.js):
// the system % answers "how much of the catalogue is built", while the phases answer "how far through the project as a
// whole are we" (analysis, infrastructure, development, training, go-live…). Each phase carries a free weight and a
// stored completion %; one phase may instead be `auto`, taking its completion LIVE from the system functions
// completion (the existing total.pct), so the development phase tracks the build automatically.
import { bad } from '../utils/http.js';

const PHASE_KEY_RE = /^[a-z0-9_-]{1,40}$/;
const PHASE_ICON_RE = /^[a-z0-9_]{1,40}$/;
const PHASES_MIN = 1, PHASES_MAX = 40, PHASE_NAME_MAX = 120, PHASE_WEIGHT_MAX = 100000;

// Validate a `project.phases` value. Returns the normalised array (trimmed names, plain numbers) or throws bad().
// Rules: an array of 1..40 phases; each has a unique non-empty slug key (^[a-z0-9_-]{1,40}$), a non-empty name_ar
// (≤120), a name_en string (≤120, may be empty), a finite weight 0..100000, a finite pct 0..100 and a boolean auto;
// at most one phase may be auto; the sum of the weights must be > 0.
export function validateProjectPhases(value) {
  if (!Array.isArray(value) || value.length < PHASES_MIN || value.length > PHASES_MAX) {
    throw bad('invalid_value', { field: 'phases' });
  }
  const keys = new Set();
  let autoCount = 0, sumW = 0;
  const out = value.map((ph, i) => {
    if (!ph || typeof ph !== 'object' || Array.isArray(ph)) throw bad('invalid_value', { field: 'phases', index: i });
    const key = ph.key;
    if (typeof key !== 'string' || !PHASE_KEY_RE.test(key)) throw bad('invalid_value', { field: 'key', index: i });
    if (keys.has(key)) throw bad('invalid_value', { field: 'key', index: i, reason: 'duplicate' });
    keys.add(key);
    const name_ar = typeof ph.name_ar === 'string' ? ph.name_ar.trim() : '';
    if (!name_ar || name_ar.length > PHASE_NAME_MAX) throw bad('invalid_value', { field: 'name_ar', index: i });
    const name_en = typeof ph.name_en === 'string' ? ph.name_en.trim() : '';
    if (name_en.length > PHASE_NAME_MAX) throw bad('invalid_value', { field: 'name_en', index: i });
    const weight = ph.weight;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > PHASE_WEIGHT_MAX) {
      throw bad('invalid_value', { field: 'weight', index: i });
    }
    const pct = ph.pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) throw bad('invalid_value', { field: 'pct', index: i });
    if (typeof ph.auto !== 'boolean') throw bad('invalid_value', { field: 'auto', index: i });
    // optional icon name (one of the frontend's icon set, validated there); here only a safe slug or empty
    const icon = typeof ph.icon === 'string' ? ph.icon.trim() : '';
    if (icon && !PHASE_ICON_RE.test(icon)) throw bad('invalid_value', { field: 'icon', index: i });
    if (ph.auto) autoCount++;
    sumW += weight;
    return { key, name_ar, name_en, icon, weight, pct, auto: ph.auto };
  });
  if (autoCount > 1) throw bad('invalid_value', { field: 'auto', reason: 'multiple_auto' });
  if (!(sumW > 0)) throw bad('invalid_value', { field: 'weight', reason: 'sum_zero' });
  return out;
}

// Weighted project completion from the stored phases and the live system %. An `auto` phase uses `systemPct` as its
// completion; any other phase uses its stored `pct`. Returns full precision (round on display, not here):
//   effective(ph) = ph.auto ? systemPct : ph.pct
//   totalW        = Σ weight
//   pct           = totalW > 0 ? Σ(weight·effective) / totalW : 0
//   phases[]      = each phase + effective_pct + contribution (its share of the 0–100 overall: weight·effective/totalW)
export function projectProgress(phases, systemPct) {
  const sp = +systemPct || 0;
  const list = Array.isArray(phases) ? phases : [];
  let totalW = 0;
  for (const ph of list) totalW += +ph.weight || 0;
  const out = list.map(ph => {
    const effective = ph.auto ? sp : (+ph.pct || 0);
    const contribution = totalW > 0 ? (+ph.weight || 0) * effective / totalW : 0;
    return { ...ph, effective_pct: effective, contribution };
  });
  const pct = out.reduce((a, ph) => a + ph.contribution, 0);
  return { pct, total_weight: totalW, phases: out };
}
