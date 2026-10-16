// Worker thread for hashManyPasswords (services/passwords.js): hashes one password per message with bcrypt.
import { parentPort } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

parentPort.on('message', ({ i, pw, rounds }) => {
  try { parentPort.postMessage({ i, hash: bcrypt.hashSync(String(pw), rounds) }); }
  catch (e) { parentPort.postMessage({ i, error: e.message }); }
});
