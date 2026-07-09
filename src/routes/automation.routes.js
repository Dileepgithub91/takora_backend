import express from 'express';
import { protect, readOnlyBlock } from '../middleware/auth.js';
import { runAutomation } from '../utils/automation.js';
import { accessibleUserIds } from '../utils/accessControl.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import { notifyUser } from '../utils/notifications.js';

const router = express.Router();
router.use(protect);

router.post('/run', readOnlyBlock, async (req, res) => {
  if (!['admin','manager'].includes(req.user.role)) return res.status(403).json({ message: 'Only admin/manager can run automation manually' });
  res.json(await runAutomation());
});

router.post('/auto-assign', readOnlyBlock, async (req, res) => {
  if (!['admin','manager','teamLead'].includes(req.user.role)) return res.status(403).json({ message: 'Permission denied' });
  const ids = await accessibleUserIds(req.user);
  const users = await User.find({ _id: { $in: ids }, department: req.body.department || req.user.department, role: { $in: ['employee','support'] }, status: 'active' });
  if (!users.length) return res.status(400).json({ message: 'No active employee found for auto assignment' });
  const workloads = await Promise.all(users.map(async u => ({ user: u, count: await Task.countDocuments({ assignedTo: u._id, status: { $nin: ['completed','cancelled'] } }) })));
  workloads.sort((a,b) => a.count - b.count);
  const assigned = workloads[0].user;
  const task = await Task.create({
    title: req.body.title,
    description: req.body.description || 'Auto assigned based on lowest workload',
    department: req.body.department || assigned.department,
    priority: req.body.priority || 'medium',
    assignedTo: assigned._id,
    assignedBy: req.user._id,
    dueDate: req.body.dueDate || new Date(Date.now() + 24 * 60 * 60 * 1000),
    activityLog: [{ actor: req.user._id, action: 'AUTO_ASSIGNED', detail: `Assigned to ${assigned.name} by workload` }]
  });
  await notifyUser({ userId: assigned._id, title: 'Auto assigned task', message: task.title, type: 'task', refType: 'Task', refId: task._id, channels: ['dashboard','email'] });
  res.status(201).json({ task, assignedTo: assigned.name });
});

export default router;
