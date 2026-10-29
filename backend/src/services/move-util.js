// Helpers shared by the two move services (services/move.js — moving items; services/app-move.js — moving a whole
// application between departments). Kept here so a rounding / weight-mode change is made in one place (BE-4).

// Money-style rounding to the 0.01 scale of applications.weight (numeric(6,2)): work in integer cents, never floats.
export const cents = v => Math.round((+v || 0) * 100);

// The weight mode read straight from its row INSIDE the caller's transaction (c), NOT through the allSettings() cache:
// a move runs under FOR UPDATE locks and must see the value as committed, so it reads the settings row directly.
export const weightMode = async c => (await c.query(`SELECT value FROM settings WHERE key='calc.weight_mode'`)).rows[0]?.value === 'auto' ? 'auto' : 'fixed';

// The person a move is recorded in the name of ({ full_name, username }), or null when there is no user id.
export const userName = async (c, id) => (id ? (await c.query('SELECT full_name, username FROM users WHERE id=$1', [id])).rows[0] : null);

// Arabic / English names of an entity flattened under a prefix, for an audit row's context.
export const names = (x, p) => ({ [p + '_name_ar']: x.name_ar, [p + '_name_en']: x.name_en });
