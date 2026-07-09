import express from 'express';
import Ticket from '../models/Ticket.js';
import { protect, readOnlyBlock } from '../middleware/auth.js';
import { accessibleUserIds } from '../utils/accessControl.js';
import { notifyMany, notifyUser } from '../utils/notifications.js';

const router = express.Router();
router.use(protect);

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const sources = ['customer', 'vendor', 'support', 'internal'];
const categories = ['websiteBug', 'customerComplaint', 'vendorIssue', 'employeeRequest', 'orderIssue', 'paymentIssue', 'other'];
const priorities = ['low', 'medium', 'high', 'urgent'];
const statuses = ['open', 'inProgress', 'waiting', 'resolved', 'closed', 'escalated'];

function clean(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function canView(reqUser, ticket, ids) {
  if (['admin', 'auditor'].includes(reqUser.role)) return true;
  if (String(ticket.createdBy?._id || ticket.createdBy) === String(reqUser._id)) return true;
  if (String(ticket.assignedTo?._id || ticket.assignedTo) === String(reqUser._id)) return true;
  return ids.includes(String(ticket.assignedTo?._id || ticket.assignedTo));
}

function canDelete(reqUser, ticket) {
  if (reqUser.role === 'admin') return true;
  return String(ticket.createdBy?._id || ticket.createdBy) === String(reqUser._id);
}

async function nextTicketNo() {
  const count = await Ticket.estimatedDocumentCount();
  return `TKR-${String(count + 1).padStart(5, '0')}-${Date.now().toString().slice(-4)}`;
}

async function populatedTicket(id) {
  return Ticket.findById(id).populate('assignedTo createdBy comments.user activityLog.actor', 'name email role department');
}

router.get('/', asyncHandler(async (req, res) => {
  const ids = await accessibleUserIds(req.user);
  const q = ['admin', 'auditor'].includes(req.user.role)
    ? {}
    : { $or: [{ assignedTo: { $in: ids } }, { createdBy: req.user._id }] };

  ['status', 'priority', 'source', 'category', 'department'].forEach(k => {
    if (req.query[k]) q[k] = req.query[k];
  });

  const tickets = await Ticket.find(q)
    .populate('assignedTo createdBy comments.user activityLog.actor', 'name email role department')
    .sort({ createdAt: -1 })
    .limit(300);

  res.json({ tickets });
}));

router.post('/', readOnlyBlock, asyncHandler(async (req, res) => {
  const title = clean(req.body.title);
  if (!title) return res.status(400).json({ message: 'Ticket title is required' });

  const ticket = await Ticket.create({
    ticketNo: await nextTicketNo(),
    source: pick(req.body.source, sources, 'internal'),
    requesterName: clean(req.body.requesterName),
    requesterEmail: clean(req.body.requesterEmail).toLowerCase(),
    requesterPhone: clean(req.body.requesterPhone),
    title,
    description: clean(req.body.description),
    category: pick(req.body.category, categories, 'other'),
    priority: pick(req.body.priority, priorities, 'low'),
    status: pick(req.body.status, statuses, 'open'),
    department: clean(req.body.department, req.user.department || 'Customer Support'),
    assignedTo: req.body.assignedTo || req.user._id,
    createdBy: req.user._id,
    slaDueDate: req.body.slaDueDate || new Date(Date.now() + 24 * 60 * 60 * 1000),
    activityLog: [{ actor: req.user._id, action: 'Ticket Created', detail: 'Ticket raised' }]
  });

  if (ticket.assignedTo) {
    await notifyUser({
      userId: ticket.assignedTo,
      title: 'New Ticket Assigned',
      message: `${ticket.ticketNo}: ${ticket.title}`,
      type: 'ticket',
      refType: 'Ticket',
      refId: ticket._id,
      channels: ['dashboard']
    });
  }

  res.status(201).json({ ticket: await populatedTicket(ticket._id) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const ticket = await populatedTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  const ids = await accessibleUserIds(req.user);
  if (!canView(req.user, ticket, ids)) return res.status(403).json({ message: 'Permission denied' });
  res.json({ ticket });
}));

router.put('/:id', readOnlyBlock, asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  const ids = await accessibleUserIds(req.user);
  if (!canView(req.user, ticket, ids)) return res.status(403).json({ message: 'Permission denied' });

  const fields = ['requesterName', 'requesterEmail', 'requesterPhone', 'title', 'description', 'department', 'assignedTo', 'slaDueDate'];
  fields.forEach(k => {
    if (req.body[k] !== undefined) ticket[k] = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
  });

  if (req.body.source !== undefined) ticket.source = pick(req.body.source, sources, ticket.source);
  if (req.body.category !== undefined) ticket.category = pick(req.body.category, categories, ticket.category);
  if (req.body.priority !== undefined) ticket.priority = pick(req.body.priority, priorities, ticket.priority);
  if (req.body.status !== undefined) ticket.status = pick(req.body.status, statuses, ticket.status);

  ticket.activityLog.push({ actor: req.user._id, action: 'Ticket Updated', detail: 'Ticket updated' });
  await ticket.save();

  const recipients = [ticket.assignedTo, ticket.createdBy]
    .filter(Boolean)
    .map(String)
    .filter(id => id !== String(req.user._id));

  await notifyMany(recipients, {
    title: 'Ticket Updated',
    message: `${ticket.ticketNo}: ${ticket.title}`,
    type: 'ticket',
    refType: 'Ticket',
    refId: ticket._id,
    channels: ['dashboard']
  });

  res.json({ ticket: await populatedTicket(ticket._id) });
}));

router.post('/:id/comments', readOnlyBlock, asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  const ids = await accessibleUserIds(req.user);
  if (!canView(req.user, ticket, ids)) return res.status(403).json({ message: 'Permission denied' });

  const message = clean(req.body.message);
  if (!message) return res.status(400).json({ message: 'Comment message required' });

  ticket.comments.push({ user: req.user._id, message });
  ticket.activityLog.push({ actor: req.user._id, action: 'Ticket Comment', detail: message });
  await ticket.save();

  const recipients = [ticket.assignedTo, ticket.createdBy]
    .filter(Boolean)
    .map(String)
    .filter(id => id !== String(req.user._id));

  await notifyMany(recipients, {
    title: 'New Ticket Comment',
    message,
    type: 'comment',
    refType: 'Ticket',
    refId: ticket._id,
    channels: ['dashboard']
  });

  res.status(201).json({ ticket: await populatedTicket(ticket._id) });
}));

router.delete('/:id', readOnlyBlock, asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  if (!canDelete(req.user, ticket)) return res.status(403).json({ message: 'Only admin or ticket creator can delete. Ticket receiver cannot delete.' });
  await ticket.deleteOne();
  res.json({ message: 'Ticket deleted' });
}));

export default router;
