import express from 'express';
import Department from '../models/Department.js';
import { protect, readOnlyBlock } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

router.get('/', async (req, res) => {
  const departments = await Department.find({}).populate('manager', 'name email role').sort({ name: 1 });
  res.json({ departments });
});

router.post('/', readOnlyBlock, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) return res.status(403).json({ message: 'Permission denied' });
  const department = await Department.create(req.body);
  res.status(201).json({ department });
});

router.put('/:id', readOnlyBlock, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) return res.status(403).json({ message: 'Permission denied' });
  const department = await Department.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json({ department });
});

router.delete('/:id', readOnlyBlock, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Only admin can delete' });
  await Department.findByIdAndDelete(req.params.id);
  res.json({ message: 'Department deleted' });
});

export default router;
