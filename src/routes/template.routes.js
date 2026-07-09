import express from 'express';
import TaskTemplate from '../models/TaskTemplate.js';
import { protect, readOnlyBlock } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

router.get('/', async (req, res) => {
  const templates = await TaskTemplate.find({}).populate('createdBy', 'name').sort({ name: 1 });
  res.json({ templates });
});

router.post('/', readOnlyBlock, async (req, res) => {
  if (!['admin', 'manager', 'teamLead'].includes(req.user.role)) return res.status(403).json({ message: 'Permission denied' });
  const template = await TaskTemplate.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ template });
});

router.put('/:id', readOnlyBlock, async (req, res) => {
  if (!['admin', 'manager', 'teamLead'].includes(req.user.role)) return res.status(403).json({ message: 'Permission denied' });
  const template = await TaskTemplate.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json({ template });
});

router.delete('/:id', readOnlyBlock, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Only admin can delete templates' });
  await TaskTemplate.findByIdAndDelete(req.params.id);
  res.json({ message: 'Template deleted' });
});

export default router;
