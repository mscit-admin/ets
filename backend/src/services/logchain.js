// Verification of the append-only hash chains of audit_log and auth_log (migration 012, ETS-SEC-013).
// Each row stores chain_seq, prev_hash and row_hash = SHA-256(prev_hash || canonical row); the database
// computes them on insert. This recomputes every hash and checks the links:
//   - hash_mismatch: the row was changed after it was written
//   - link_broken:   prev_hash is not the row_hash of the row before (a row was inserted or replaced)
//   - gap:           chain_seq numbers are missing (rows deleted in the middle)
//   - start:         the chain does not start at 1 and no retention purge (log_chain_anchor) explains it
//   - unchained:     rows without chain values (written with the triggers disabled)
//   - tail:          the last row is not the recorded head (rows deleted at the end)
// The head (seq + hash) of each chain is also written to the file log / journald every day (see retention.js):
// comparing it with a head recorded outside the database detects a chain that was rebuilt end to end.
import { pool } from '../db/pool.js';

export const CHAINED = { audit_log: 'ets_audit_row_text', auth_log: 'ets_auth_row_text' };
const BATCH = 5000;
const MAX_BREAKS = 100;

// db: a client inside one REPEATABLE READ snapshot (verifyAll), so rows written meanwhile do not look like breaks.
async function verifyChain(db, tbl) {
  const query = (sql, p) => db.query(sql, p);
  const fn = CHAINED[tbl];
  if (!fn) throw new Error('not a chained table: ' + tbl);
  const breaks = [];
  const add = b => { if (breaks.length < MAX_BREAKS) breaks.push(b); };
  const unchained = (await query(`SELECT count(*)::int AS n FROM ${tbl} WHERE chain_seq IS NULL OR row_hash IS NULL`)).rows[0].n;
  if (unchained) add({ kind: 'unchained', rows: unchained });
  let prev = null, rows = 0, first = null, last = null, more = true, after = 0;
  while (more) {
    const batch = (await query(`SELECT l.id, l.chain_seq, l.prev_hash, l.row_hash, ets_chain_hash(l.prev_hash, ${fn}(l)) AS calc
      FROM ${tbl} l WHERE l.chain_seq > $1 ORDER BY l.chain_seq LIMIT ${BATCH}`, [after])).rows;
    more = batch.length === BATCH;
    for (const r of batch) {
      const seq = Number(r.chain_seq);
      rows++;
      if (!first) first = r;
      if (r.calc !== r.row_hash) add({ kind: 'hash_mismatch', seq, id: Number(r.id) });
      if (prev) {
        if (seq !== Number(prev.chain_seq) + 1) add({ kind: 'gap', seq, id: Number(r.id), after_seq: Number(prev.chain_seq) });
        else if (r.prev_hash !== prev.row_hash) add({ kind: 'link_broken', seq, id: Number(r.id) });
      }
      prev = r;
      after = seq;
    }
  }
  last = prev;
  const anchors = (await query('SELECT next_seq, prev_hash, deleted, ts, actor FROM log_chain_anchor WHERE tbl=$1 ORDER BY next_seq', [tbl])).rows;
  const head = (await query('SELECT last_seq, last_hash FROM log_chain_head WHERE tbl=$1', [tbl])).rows[0] || { last_seq: 0, last_hash: '' };
  // where the remaining chain may start: at 1 with '' or where a purge left it
  if (first) {
    const fs = Number(first.chain_seq);
    const ok = (fs === 1 && first.prev_hash === '') ||
      anchors.some(a => Number(a.next_seq) === fs && a.prev_hash === first.prev_hash);
    if (!ok) add({ kind: 'start', seq: fs, id: Number(first.id) });
  }
  const headSeq = Number(head.last_seq);
  if (last ? (Number(last.chain_seq) !== headSeq || last.row_hash !== head.last_hash)
    : !(headSeq === 0 || anchors.some(a => Number(a.next_seq) === headSeq + 1 && a.prev_hash === head.last_hash))) {
    add({ kind: 'tail', seq: last ? Number(last.chain_seq) : null, head_seq: headSeq });
  }
  return {
    table: tbl, ok: breaks.length === 0, rows, first_seq: first ? Number(first.chain_seq) : null,
    last_seq: last ? Number(last.chain_seq) : null, head: { seq: headSeq, hash: head.last_hash },
    purges: anchors.length, breaks,
  };
}

export async function verifyAll() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = [];
    for (const t of Object.keys(CHAINED)) out.push(await verifyChain(c, t));
    return { ok: out.every(x => x.ok), checked_at: new Date().toISOString(), tables: out };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

export async function chainHeads() {
  const rows = (await pool.query('SELECT tbl, last_seq, last_hash FROM log_chain_head ORDER BY tbl')).rows;
  return Object.fromEntries(rows.map(r => [r.tbl, { seq: Number(r.last_seq), hash: r.last_hash }]));
}
