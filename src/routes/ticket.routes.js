import express from 'express';
import xlsx from 'xlsx';
import Ticket from '../models/Ticket.js';
import User from '../models/User.js';
import { protect, readOnlyBlock } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { uploadBufferToS3 } from '../utils/s3Upload.js';
import { accessibleUserIds } from '../utils/accessControl.js';
import { notifyMany, notifyUser } from '../utils/notifications.js';
import { calculateDueDate, priorityToSlaHours, visibleSlaLabel } from '../utils/sla.js';

const router = express.Router();
router.use(protect);

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const sources = ['customer', 'vendor', 'support', 'internal'];
const categories = ['websiteBug', 'customerComplaint', 'vendorIssue', 'employeeRequest', 'orderIssue', 'paymentIssue', 'other'];
const priorities = ['low', 'medium', 'high', 'urgent'];
const statuses = ['open', 'inProgress', 'waiting', 'resolved', 'closed', 'escalated', 'rejected'];
const closedStatuses = ['closed', 'rejected'];
const managementRoles = ['admin', 'manager', 'teamLead'];

function clean(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizePriority(value, fallback = 'low') {
  const priority = String(value || '').trim().toLowerCase();
  return priorities.includes(priority) ? priority : fallback;
}

function isManagement(user) {
  return managementRoles.includes(user?.role);
}

function ticketIsClosed(ticket) {
  return closedStatuses.includes(ticket.status) || ['approved', 'managerApproved', 'adminApproved'].includes(ticket.approvalStatus);
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

function addActivity(ticket, user, action, detail = '') {
  ticket.activityLog.push({ actor: user._id, action, detail });
}


async function buildTicketQuery(req) {
  const ids = await accessibleUserIds(req.user);
  const baseAccess = ['admin', 'auditor'].includes(req.user.role)
    ? null
    : { $or: [{ assignedTo: { $in: ids } }, { createdBy: req.user._id }, { department: req.user.department }] };

  const filters = {};
  if (req.query.status) filters.status = pick(req.query.status, statuses, req.query.status);
  if (req.query.priority) filters.priority = normalizePriority(req.query.priority, req.query.priority);
  if (req.query.source) filters.source = pick(req.query.source, sources, req.query.source);
  if (req.query.category) filters.category = pick(req.query.category, categories, req.query.category);
  if (req.query.department) filters.department = clean(req.query.department);

  if (req.query.assignedTo && ['admin', 'manager'].includes(req.user.role)) {
    const allowed = req.user.role === 'admin' ? null : ids;
    if (!allowed || allowed.includes(String(req.query.assignedTo))) filters.assignedTo = req.query.assignedTo;
  }

  const employeeSearch = clean(req.query.employeeSearch);
  if (!filters.assignedTo && employeeSearch && !/^all employees$/i.test(employeeSearch) && ['admin', 'manager'].includes(req.user.role)) {
    const allowed = req.user.role === 'admin' ? null : ids;
    const userQuery = {
      status: 'active',
      $or: [
        { name: { $regex: employeeSearch, $options: 'i' } },
        { email: { $regex: employeeSearch, $options: 'i' } },
        { employeeId: { $regex: employeeSearch, $options: 'i' } },
        { department: { $regex: employeeSearch, $options: 'i' } }
      ]
    };
    if (allowed) userQuery._id = { $in: allowed };
    const matchedUsers = await User.find(userQuery).select('_id').limit(100).lean();
    filters.assignedTo = { $in: matchedUsers.map(u => u._id) };
  }

  if (req.query.from || req.query.to) filters.slaDueDate = {};
  if (req.query.from) filters.slaDueDate.$gte = new Date(req.query.from);
  if (req.query.to) filters.slaDueDate.$lte = new Date(req.query.to);

  if (req.query.createdFrom || req.query.createdTo) filters.createdAt = {};
  if (req.query.createdFrom) filters.createdAt.$gte = new Date(`${req.query.createdFrom}T00:00:00.000+05:30`);
  if (req.query.createdTo) filters.createdAt.$lte = new Date(`${req.query.createdTo}T23:59:59.999+05:30`);

  const search = clean(req.query.search);
  const searchQuery = search ? {
    $or: [
      { title: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
      { ticketNo: { $regex: search, $options: 'i' } },
      { requesterName: { $regex: search, $options: 'i' } },
      { requesterEmail: { $regex: search, $options: 'i' } }
    ]
  } : null;

  const and = [baseAccess, filters, searchQuery].filter(Boolean);
  if (and.length === 0) return {};
  if (and.length === 1) return and[0];
  return { $and: and };
}

async function fileToAttachment(file, user) {
  const uploaded = await uploadBufferToS3(file, 'ticket-attachments');

  return {
    filename: uploaded.filename,
    originalName: uploaded.originalName,
    path: '',
    mimetype: uploaded.mimetype,
    size: uploaded.size,
    storage: uploaded.storage,
    fileKey: uploaded.key,
    uploadedBy: user._id
  };
}

async function nextTicketNo() {
  const count = await Ticket.estimatedDocumentCount();
  return `TKR-${String(count + 1).padStart(5, '0')}-${Date.now().toString().slice(-4)}`;
}

function populateTicket(query) {
  return query
    .populate('assignedTo createdBy comments.user attachments.uploadedBy extensionRequests.requestedBy extensionRequests.reviewedBy activityLog.actor', 'name email role department avatar')
    .lean();
}

async function populatedTicket(id) {
  return populateTicket(Ticket.findById(id));
}

async function ticketReviewerRecipients(ticket, actorId = null) {
  const [admins, managers, assigned, creator] = await Promise.all([
    User.find({ role: 'admin', status: 'active' }).select('_id').lean(),
    User.find({ role: { $in: ['manager', 'teamLead'] }, status: 'active', department: ticket.department }).select('_id').lean(),
    ticket.assignedTo ? User.findById(ticket.assignedTo).select('_id reportingManager').lean() : null,
    ticket.createdBy ? User.findById(ticket.createdBy).select('_id reportingManager').lean() : null
  ]);

  const ids = [
    ...admins.map(u => u._id),
    ...managers.map(u => u._id),
    assigned?.reportingManager,
    creator?.reportingManager,
    ticket.createdBy
  ];

  return [...new Set(ids.filter(Boolean).map(String))].filter(id => String(id) !== String(actorId || ''));
}

router.get('/', asyncHandler(async (req, res) => {
  const q = await buildTicketQuery(req);
  const tickets = await populateTicket(Ticket.find(q))
    .sort({ createdAt: -1, updatedAt: -1 })
    .limit(Math.min(Number(req.query.limit || 200), 500));

  res.json({ tickets });
}));

router.post('/', readOnlyBlock, asyncHandler(async (req, res) => {
  const title = clean(req.body.title);
  if (!title) return res.status(400).json({ message: 'Ticket title is required' });

  const priority = normalizePriority(req.body.priority, 'low');
  const slaHours = priorityToSlaHours(priority);
  const startDate = new Date();

  const ticket = await Ticket.create({
    ticketNo: await nextTicketNo(),
    source: pick(req.body.source, sources, 'internal'),
    requesterName: clean(req.body.requesterName),
    requesterEmail: clean(req.body.requesterEmail).toLowerCase(),
    requesterPhone: clean(req.body.requesterPhone),
    title,
    description: clean(req.body.description),
    category: pick(req.body.category, categories, 'other'),
    priority,
    slaHours,
    status: pick(req.body.status, statuses, 'open'),
    approvalStatus: 'notSubmitted',
    department: clean(req.body.department, req.user.department || 'Customer Support'),
    assignedTo: req.body.assignedTo || req.user._id,
    createdBy: req.user._id,
    slaDueDate: req.body.slaDueDate || calculateDueDate({ startDate, priority, slaHours }),
    activityLog: [{ actor: req.user._id, action: 'Ticket Created', detail: `Ticket raised with ${visibleSlaLabel(priority)} SLA` }]
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


router.get('/calendar', asyncHandler(async (req, res) => {
  const query = await buildTicketQuery(req);
  const tickets = await Ticket.find(query)
    .select('ticketNo title status priority slaDueDate assignedTo department createdAt')
    .populate('assignedTo', 'name role department')
    .sort({ createdAt: -1, slaDueDate: 1 })
    .lean();

  res.json({
    events: tickets.map(ticket => ({
      id: ticket._id,
      ticketNo: ticket.ticketNo,
      title: ticket.title,
      date: ticket.slaDueDate || ticket.createdAt,
      createdAt: ticket.createdAt,
      status: ticket.status,
      priority: ticket.priority,
      department: ticket.department,
      assignedTo: ticket.assignedTo?.name,
      assignedToId: ticket.assignedTo?._id,
      role: ticket.assignedTo?.role
    }))
  });
}));

async function ticketImportTemplate(req, res) {
  const rows = [
    {
      title: 'Customer refund follow up',
      description: 'Check refund status and update customer',
      source: 'customer',
      category: 'customerComplaint',
      priority: 'medium',
      status: 'open',
      assignedEmail: 'support@takoramart.com',
      requesterName: 'Customer Name',
      requesterEmail: 'customer@example.com',
      requesterPhone: '9876543210',
      department: 'Customer Support',
      createdAt: '2026-07-11 10:00'
    },
    {
      title: 'Vendor image issue',
      description: 'Vendor product image not opening',
      source: 'vendor',
      category: 'vendorIssue',
      priority: 'high',
      status: 'inProgress',
      assignedEmail: 'marketing@takoramart.com',
      requesterName: 'Vendor Name',
      requesterEmail: 'vendor@example.com',
      requesterPhone: '9876543211',
      department: 'Marketing',
      createdAt: '2026-07-11 11:30'
    }
  ];
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(wb, ws, 'Tickets');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=takora-ticket-import-template.xlsx');
  res.send(buffer);
}

router.get('/import-template', asyncHandler(ticketImportTemplate));
router.get('/template', asyncHandler(ticketImportTemplate));
router.get('/download-template', asyncHandler(ticketImportTemplate));

async function bulkImportTickets(req, res) {
  let items = req.body.tickets || [];
  if (typeof items === 'string') items = JSON.parse(items);

  if (req.file) {
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    items = xlsx.utils.sheet_to_json(sheet);
  }

  const created = [];
  const skipped = [];

  for (const row of items) {
    try {
      const title = clean(row.title);
      if (!title) throw new Error('Ticket title is required');

      const assigned =
        await User.findOne({ email: String(row.assignedEmail || row.assignedToEmail || row.email || '').trim().toLowerCase() }) ||
        await User.findById(row.assignedTo).catch(() => null);

      if (!assigned) throw new Error('Assigned employee email/id not found');

      const priority = normalizePriority(row.priority, 'low');
      const status = pick(String(row.status || 'open').trim(), statuses, 'open');
      const createdAt = row.createdAt ? new Date(row.createdAt) : new Date();
      const slaHours = priorityToSlaHours(priority);

      const ticket = await Ticket.create({
        ticketNo: await nextTicketNo(),
        source: pick(String(row.source || 'internal').trim(), sources, 'internal'),
        requesterName: clean(row.requesterName),
        requesterEmail: clean(row.requesterEmail).toLowerCase(),
        requesterPhone: clean(row.requesterPhone),
        title,
        description: clean(row.description),
        category: pick(String(row.category || 'other').trim(), categories, 'other'),
        priority,
        slaHours,
        status,
        approvalStatus: status === 'closed' ? 'adminApproved' : 'notSubmitted',
        department: clean(row.department, assigned.department || req.user.department || 'Customer Support'),
        assignedTo: assigned._id,
        createdBy: req.user._id,
        slaDueDate: calculateDueDate({ startDate: createdAt, priority, slaHours }),
        createdAt,
        updatedAt: createdAt,
        activityLog: [{ actor: req.user._id, action: 'Imported From Excel', detail: `Ticket imported with ${visibleSlaLabel(priority)} SLA` }]
      });

      created.push(ticket);
    } catch (error) {
      skipped.push({ row, reason: error.message });
    }
  }

  res.status(201).json({ count: created.length, skippedCount: skipped.length, skipped, tickets: created });
}

router.post('/bulk', readOnlyBlock, upload.single('file'), asyncHandler(bulkImportTickets));
router.post('/import', readOnlyBlock, upload.single('file'), asyncHandler(bulkImportTickets));



async function changeTicketStatus(req, res) {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

  const ids = await accessibleUserIds(req.user);
  if (!canView(req.user, ticket, ids)) return res.status(403).json({ message: 'Permission denied' });
  if (ticketIsClosed(ticket)) return res.status(400).json({ message: 'Approved/closed ticket cannot change status' });

  const status = pick(req.body.status, statuses, '');
  if (!status) return res.status(400).json({ message: 'Invalid ticket status' });

  const oldStatus = ticket.status;
  ticket.status = status;

  if (status === 'resolved') {
    ticket.resolvedAt = ticket.resolvedAt || new Date();
    // Same as task dashboard: resolved/completed work waits for admin/manager approval.
    if (!['submitted', 'pending', 'adminApproved', 'managerApproved', 'approved'].includes(ticket.approvalStatus)) {
      ticket.approvalStatus = 'notSubmitted';
    }
  }

  if (status === 'closed') {
    if (!isManagement(req.user)) return res.status(403).json({ message: 'Only admin/manager/team lead can close ticket directly' });
    ticket.closedAt = ticket.closedAt || new Date();
    ticket.approvalStatus = req.user.role === 'admin' ? 'adminApproved' : 'managerApproved';
  }

  addActivity(ticket, req.user, 'Ticket Status Changed', `Status changed from ${oldStatus} to ${status}`);
  await ticket.save();

  const recipients = [ticket.assignedTo, ticket.createdBy]
    .filter(Boolean)
    .map(String)
    .filter(id => id !== String(req.user._id));

  await notifyMany(recipients, {
    title: 'Ticket Status Updated',
    message: `${req.user.name} changed ${ticket.ticketNo} to ${status}`,
    type: 'ticket',
    refType: 'Ticket',
    refId: ticket._id,
    channels: ['dashboard']
  });

  res.json({ ticket: await populatedTicket(ticket._id) });
}

// Status endpoint used by ticket dashboard. Put before /:id routes and keep PATCH/PUT/POST for compatibility.
router.patch('/:id/status', readOnlyBlock, asyncHandler(changeTicketStatus));
router.put('/:id/status', readOnlyBlock, asyncHandler(changeTicketStatus));
router.post('/:id/status', readOnlyBlock, asyncHandler(changeTicketStatus));

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
  if (ticketIsClosed(ticket)) return res.status(400).json({ message: 'Closed/approved ticket cannot be edited' });

  const fields = ['requesterName', 'requesterEmail', 'requesterPhone', 'title', 'description', 'department', 'assignedTo', 'slaDueDate'];
  fields.forEach(k => {
    if (req.body[k] !== undefined) ticket[k] = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
  });

  if (req.body.source !== undefined) ticket.source = pick(req.body.source, sources, ticket.source);
  if (req.body.category !== undefined) ticket.category = pick(req.body.category, categories, ticket.category);
  if (req.body.priority !== undefined) {
    const priority = normalizePriority(req.body.priority, ticket.priority);
    if (priority !== ticket.priority) {
      ticket.priority = priority;
      ticket.slaHours = priorityToSlaHours(priority);
      ticket.slaDueDate = calculateDueDate({ startDate: ticket.createdAt || new Date(), priority, slaHours: ticket.slaHours });
    }
  }
  if (req.body.status !== undefined) ticket.status = pick(req.body.status, statuses, ticket.status);
  if (ticket.status === 'resolved') ticket.resolvedAt = ticket.resolvedAt || new Date();
  if (ticket.status === 'closed') ticket.closedAt = ticket.closedAt || new Date();

  addActivity(ticket, req.user, 'Ticket Updated', 'Ticket updated');
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

router.post('/:id/comments', readOnlyBlock, upload.array('files', 5), asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  const ids = await accessibleUserIds(req.user);
  if (!canView(req.user, ticket, ids)) return res.status(403).json({ message: 'Permission denied' });

  const message = clean(req.body.message);
  if (!message) return res.status(400).json({ message: 'Comment message required' });

  const attachments = await Promise.all((req.files || []).map(f => fileToAttachment(f, req.user)));
  ticket.comments.push({ user: req.user._id, message, attachments });
  addActivity(ticket, req.user, 'Ticket Comment', message);
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

router.post('/:id/attachments', readOnlyBlock, upload.array('files', 10), asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  const ids = await accessibleUserIds(req.user);
  if (!canView(req.user, ticket, ids)) return res.status(403).json({ message: 'Permission denied' });

  const attachments = await Promise.all((req.files || []).map(f => fileToAttachment(f, req.user)));
  ticket.attachments.push(...attachments);
  addActivity(ticket, req.user, 'Files Uploaded', `${attachments.length} file(s) uploaded`);
  await ticket.save();

  res.json({ ticket: await populatedTicket(ticket._id) });
}));

router.post('/:id/extension', readOnlyBlock, asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  const ids = await accessibleUserIds(req.user);
  if (!canView(req.user, ticket, ids)) return res.status(403).json({ message: 'Permission denied' });
  if (ticketIsClosed(ticket)) return res.status(400).json({ message: 'Closed/approved ticket cannot request extension' });

  const requestedHours = Number(req.body.requestedHours || 0);
  if (![1, 2, 4, 6, 8].includes(requestedHours)) return res.status(400).json({ message: 'Select requested extra official hours' });

  const requestedDueDate = calculateDueDate({ startDate: ticket.slaDueDate || new Date(), priority: 'medium', slaHours: requestedHours });
  ticket.extensionRequests.push({
    requestedBy: req.user._id,
    currentDueDate: ticket.slaDueDate,
    requestedDueDate,
    requestedHours,
    reason: clean(req.body.reason, 'Need more time')
  });

  addActivity(ticket, req.user, 'Ticket Extension Requested', `${requestedHours} extra official hour(s)`);
  await ticket.save();

  const reviewers = await ticketReviewerRecipients(ticket, req.user._id);
  await notifyMany(reviewers, {
    title: 'Ticket SLA Extension Request',
    message: `${req.user.name} requested ${requestedHours} extra official hour(s) for ${ticket.ticketNo}`,
    type: 'deadline',
    refType: 'Ticket',
    refId: ticket._id,
    channels: ['dashboard']
  });

  res.status(201).json({ ticket: await populatedTicket(ticket._id) });
}));

async function resolveExtensionRequest(req, res) {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  if (!isManagement(req.user)) return res.status(403).json({ message: 'Only admin/manager/team lead can review extension requests' });

  const ext = ticket.extensionRequests.id(req.params.requestId);
  if (!ext) return res.status(404).json({ message: 'Extension request not found' });

  const decision = req.body.status || req.body.decision;
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ message: 'Status must be approved or rejected' });

  ext.status = decision;
  ext.reviewedBy = req.user._id;
  ext.reviewComment = clean(req.body.reviewComment);
  ext.reviewedAt = new Date();

  if (decision === 'approved') {
    ticket.slaDueDate = ext.requestedDueDate;
    if (ticket.status === 'escalated') ticket.status = 'inProgress';
  }

  addActivity(ticket, req.user, `Ticket Extension ${decision}`, ext.reviewComment);
  await ticket.save();

  await notifyUser({
    userId: ext.requestedBy,
    title: `Ticket Extension Request ${decision}`,
    message: `${ticket.ticketNo} extension request ${decision}.`,
    type: 'deadline',
    refType: 'Ticket',
    refId: ticket._id,
    channels: ['dashboard']
  });

  res.json({ ticket: await populatedTicket(ticket._id) });
}

router.put('/:id/extension/:requestId', readOnlyBlock, asyncHandler(resolveExtensionRequest));
router.patch('/:id/extension/:requestId', readOnlyBlock, asyncHandler(resolveExtensionRequest));

router.post('/:id/submit', readOnlyBlock, asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  const ids = await accessibleUserIds(req.user);
  if (!canView(req.user, ticket, ids)) return res.status(403).json({ message: 'Permission denied' });
  if (ticketIsClosed(ticket)) return res.status(400).json({ message: 'Closed/approved ticket cannot be submitted' });

  ticket.approvalStatus = 'submitted';
  ticket.status = 'waiting';
  addActivity(ticket, req.user, 'Ticket Submitted For Approval', 'Ticket submitted for admin/manager approval');
  await ticket.save();

  const reviewers = await ticketReviewerRecipients(ticket, req.user._id);
  await notifyMany(reviewers, {
    title: 'Ticket Submitted For Approval',
    message: `${req.user.name} submitted ${ticket.ticketNo} for approval`,
    type: 'approval',
    refType: 'Ticket',
    refId: ticket._id,
    channels: ['dashboard']
  });

  res.json({ ticket: await populatedTicket(ticket._id) });
}));

router.post('/:id/approve', readOnlyBlock, asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  if (!isManagement(req.user)) return res.status(403).json({ message: 'Only admin/manager/team lead can approve tickets' });

  ticket.approvalStatus = req.user.role === 'admin' ? 'adminApproved' : 'managerApproved';
  ticket.status = 'closed';
  ticket.closedAt = new Date();
  ticket.resolvedAt = ticket.resolvedAt || new Date();
  addActivity(ticket, req.user, 'Ticket Approved And Closed', clean(req.body.comment, 'Approved'));
  await ticket.save();

  if (ticket.assignedTo) {
    await notifyUser({
      userId: ticket.assignedTo,
      title: 'Ticket Approved And Closed',
      message: `${ticket.ticketNo}: ${ticket.title} has been approved and closed`,
      type: 'approval',
      refType: 'Ticket',
      refId: ticket._id,
      channels: ['dashboard']
    });
  }

  res.json({ ticket: await populatedTicket(ticket._id) });
}));

router.post('/:id/reject', readOnlyBlock, asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  if (!isManagement(req.user)) return res.status(403).json({ message: 'Only admin/manager/team lead can reject tickets' });

  const reason = clean(req.body.reason, 'Rejected');
  ticket.approvalStatus = 'rejected';
  ticket.status = 'rejected';
  addActivity(ticket, req.user, 'Ticket Rejected', reason);
  await ticket.save();

  if (ticket.assignedTo) {
    await notifyUser({
      userId: ticket.assignedTo,
      title: 'Ticket Rejected',
      message: `${ticket.ticketNo}: ${reason}`,
      type: 'approval',
      refType: 'Ticket',
      refId: ticket._id,
      channels: ['dashboard']
    });
  }

  res.json({ ticket: await populatedTicket(ticket._id) });
}));

router.delete('/:id', readOnlyBlock, asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
  if (!canDelete(req.user, ticket)) return res.status(403).json({ message: 'Only admin or ticket creator can delete. Ticket receiver cannot delete.' });
  await ticket.deleteOne();
  res.json({ message: 'Ticket deleted' });
}));

export default router;
