// Dashboard aggregate data that is not part of the per-reader tracker summary (routes/tracker.js).
//   GET /api/dashboard/users-overview — system administrators only ('usr' + admin role, exactly like the Users
//     screen and the online-users list): aggregated user statistics (counts only, no per-user data) for the
//     dashboard's «نظرة عامة على المستخدمين» section. A reader without 'usr' gets 403 and the section is not shown.
import { Router } from 'express';
import { requireAuth, requirePerm, requireAdmin } from '../middleware/auth.js';
import { usersOverview } from '../services/userStats.js';

const r = Router();

r.get('/users-overview', requireAuth, requirePerm('usr'), requireAdmin, async (req, res) => {
  res.json(await usersOverview());
});

export default r;
