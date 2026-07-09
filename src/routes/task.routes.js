import express from 'express';
import xlsx from 'xlsx';
import Task from '../models/Task.js';
import User from '../models/User.js';
import TaskTemplate from '../models/TaskTemplate.js';
import { protect, readOnlyBlock } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { uploadBufferToS3 } from '../utils/s3Upload.js';
import { canModifyTask, canViewTask, taskQueryForUser, accessibleUserIds } from '../utils/accessControl.js';
import { notifyMany, notifyUser } from '../utils/notifications.js';
import { calculateDueDate, managerRecipientsForTask, priorityToSlaHours, refreshOverdueTasks, visibleSlaLabel } from '../utils/sla.js';

const router = express.Router();
router.use(protect);

const taskStatuses = ['todo', 'inProgress', 'review', 'completed', 'overdue', 'cancelled', 'rejected'];
const priorityValues = ['low', 'medium', 'high', 'urgent'];

function addActivity(task, user, action, detail = '') {
  task.activityLog.push({ actor: user._id, action, detail });
}

async function populateTask(query) {
  return query
    .populate('assignedTo assignedBy watchers', 'name email role department phone whatsapp workStatus avatar employeeId reportingManager')
    .populate('dependencies', 'title status dueDate')
    .populate('comments.user', 'name email role avatar')
    .populate('extensionRequests.requestedBy extensionRequests.reviewedBy', 'name email role department avatar')
    .populate('activityLog.actor', 'name email role avatar');
}

function cleanText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizePriority(priority) {
  const value = String(priority || '').trim().toLowerCase();
  return priorityValues.includes(value) ? value : '';
}

function taskIsClosed(task) {
  return ['completed', 'cancelled', 'rejected'].includes(task.status) || ['adminApproved', 'managerApproved'].includes(task.approvalStatus);
}

async function fileToAttachment(file, user) {
  const uploaded = await uploadBufferToS3(file, 'task-attachments');

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

async function applyTemplate(body) {
  if (!body.templateName) return body;
  const template = await TaskTemplate.findOne({ name: body.templateName });
  if (!template) return body;
  return {
    ...body,
    description: body.description || template.description,
    category: body.category || template.category,
    department: body.department || template.department,
    priority: body.priority || template.priority,
    subtasks: body.subtasks?.length ? body.subtasks : template.subtasks.map(s => ({ title: s.title }))
  };
}

async function buildTaskQuery(req) {
  await refreshOverdueTasks(await taskQueryForUser(req.user));
  const base = await taskQueryForUser(req.user);
  const q = { ...base };

  if (req.query.status) q.status = req.query.status;
  if (req.query.priority) q.priority = req.query.priority;
  if (req.query.department) q.department = req.query.department;

  // Only admin and manager may search/filter across employees.
  if (req.query.assignedTo && ['admin', 'manager'].includes(req.user.role)) {
    const allowed = req.user.role === 'admin' ? null : await accessibleUserIds(req.user);
    if (!allowed || allowed.includes(String(req.query.assignedTo))) q.assignedTo = req.query.assignedTo;
  }

  if (req.query.from || req.query.to) q.dueDate = {};
  if (req.query.from) q.dueDate.$gte = new Date(req.query.from);
  if (req.query.to) q.dueDate.$lte = new Date(req.query.to);
  if (req.query.search) q.$text = { $search: req.query.search };
  return q;
}

function computeTaskDates(body) {
  const priority = normalizePriority(body.priority);
  if (!priority) throw new Error('Task priority is required');
  const startDate = body.startDate ? new Date(body.startDate) : new Date();
  const slaHours = priorityToSlaHours(priority);
  const dueDate = calculateDueDate({ startDate, priority, slaHours });
  return { priority, startDate, slaHours, dueDate };
}

async function setTaskAssigneeAndDefaults(req, body) {
  const assignedTo = await User.findById(body.assignedTo);
  if (!assignedTo || assignedTo.status !== 'active') throw new Error('Assigned active employee not found');
  const { priority, startDate, slaHours, dueDate } = computeTaskDates(body);
  return { assignedTo, priority, startDate, slaHours, dueDate };
}

router.get('/', async (req, res) => {
  const q = await buildTaskQuery(req);
  const tasks = await populateTask(Task.find(q).sort({ status: 1, dueDate: 1, createdAt: -1 }));
  res.json({ tasks });
});

router.get('/calendar', async (req, res) => {
  const q = await buildTaskQuery(req);
  const tasks = await Task.find(q)
    .select('title status priority dueDate assignedTo department')
    .populate('assignedTo', 'name role department')
    .sort({ dueDate: 1 });

  res.json({
    events: tasks.map(t => ({
      id: t._id,
      title: t.title,
      date: t.dueDate,
      status: t.status,
      priority: t.priority,
      department: t.department,
      assignedTo: t.assignedTo?.name,
      assignedToId: t.assignedTo?._id,
      role: t.assignedTo?.role
    }))
  });
});

router.get('/import-template', async (req, res) => {
  const rows = [
    { title: 'Vendor Follow Up', description: 'Call vendor and update onboarding status', assignedEmail: 'marketing@takoramart.com', priority: 'medium', category: 'Vendor Onboarding', department: 'Marketing' },
    { title: 'Product Image Check', description: 'Check image quality and report issues', assignedEmail: 'support@takoramart.com', priority: 'high', category: 'Product Upload', department: 'Customer Support' }
  ];
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(wb, ws, 'Tasks');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=takora-task-import-template.xlsx');
  res.send(buffer);
});

router.get('/import/template', async (req, res) => {
  const rows = [
    { title: 'Vendor Follow Up', description: 'Call vendor and update onboarding status', assignedEmail: 'marketing@takoramart.com', priority: 'medium', category: 'Vendor Onboarding', department: 'Marketing' },
    { title: 'Product Image Check', description: 'Check image quality and report issues', assignedEmail: 'support@takoramart.com', priority: 'high', category: 'Product Upload', department: 'Customer Support' }
  ];
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(wb, ws, 'Tasks');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=takora-task-import-template.xlsx');
  res.send(buffer);
});

router.post('/', readOnlyBlock, async (req, res) => {
  const body = await applyTemplate(req.body);
  let defaults;
  try {
    defaults = await setTaskAssigneeAndDefaults(req, body);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }

  const blockers = body.dependencies?.length ? await Task.find({ _id: { $in: body.dependencies }, status: { $ne: 'completed' } }) : [];
  if (blockers.length) return res.status(400).json({ message: 'Dependent task must be completed before creating this task' });

  const task = await Task.create({
    title: cleanText(body.title),
    description: cleanText(body.description),
    category: cleanText(body.category, 'General'),
    project: cleanText(body.project, 'Takora Mart'),
    department: cleanText(body.department, defaults.assignedTo.department || req.user.department || 'General'),
    branch: cleanText(body.branch, defaults.assignedTo.branch || req.user.branch || 'Thrissur'),
    priority: defaults.priority,
    status: taskStatuses.includes(body.status) ? body.status : 'todo',
    assignedTo: defaults.assignedTo._id,
    assignedBy: req.user._id,
    watchers: body.watchers || [],
    dueDate: defaults.dueDate,
    startDate: defaults.startDate,
    slaHours: defaults.slaHours,
    subtasks: body.subtasks || [],
    dependencies: body.dependencies || [],
    recurring: body.recurring || { enabled: false, frequency: 'none' },
    templateName: body.templateName || ''
  });

  addActivity(task, req.user, 'Task Created', `${visibleSlaLabel(task.priority)} SLA assigned to ${defaults.assignedTo.name}`);
  await task.save();
  await notifyMany([defaults.assignedTo._id, ...(body.watchers || [])], {
    title: 'New Task Assigned',
    message: `${req.user.name} assigned ${task.title}. SLA: ${visibleSlaLabel(task.priority)}.`,
    type: 'task',
    refType: 'Task',
    refId: task._id,
    channels: ['dashboard', 'email', 'whatsapp', 'sms']
  });
  res.status(201).json({ task: await populateTask(Task.findById(task._id)) });
});

async function bulkImportTasks(req, res) {
  let items = req.body.tasks || [];
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
      const assigned = await User.findOne({ email: row.assignedEmail || row.assignedToEmail || row.email }) || await User.findById(row.assignedTo).catch(() => null);
      if (!assigned) throw new Error('Assigned employee email/id not found');
      const priority = normalizePriority(row.priority);
      if (!priority) throw new Error('Priority required: urgent/high/medium/low');
      const startDate = row.startDate ? new Date(row.startDate) : new Date();
      const slaHours = priorityToSlaHours(priority);
      const task = await Task.create({
        title: cleanText(row.title),
        description: cleanText(row.description),
        category: cleanText(row.category, 'Imported Task'),
        department: cleanText(row.department, assigned.department || req.user.department),
        branch: cleanText(row.branch, assigned.branch || req.user.branch),
        priority,
        assignedTo: assigned._id,
        assignedBy: req.user._id,
        startDate,
        dueDate: calculateDueDate({ startDate, priority, slaHours }),
        slaHours
      });
      addActivity(task, req.user, 'Imported From Excel', 'Created from bulk Excel upload');
      await task.save();
      created.push(task);
      await notifyUser({ userId: assigned._id, title: 'Imported Task Assigned', message: `${task.title}. SLA: ${visibleSlaLabel(task.priority)}.`, type: 'task', refType: 'Task', refId: task._id, channels: ['dashboard', 'email'] });
    } catch (err) {
      skipped.push({ row, reason: err.message });
    }
  }
  res.status(201).json({ count: created.length, skippedCount: skipped.length, skipped, tasks: created });
}

router.post('/bulk', readOnlyBlock, upload.single('file'), bulkImportTasks);
router.post('/import', readOnlyBlock, upload.single('file'), bulkImportTasks);

router.get('/:id', async (req, res) => {
  const task = await populateTask(Task.findById(req.params.id));
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canViewTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  res.json({ task });
});

router.put('/:id', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  if (taskIsClosed(task)) return res.status(400).json({ message: 'Closed task cannot be edited' });

  if (req.body.dependencies?.length) {
    const blockers = await Task.find({ _id: { $in: req.body.dependencies }, status: { $ne: 'completed' } });
    if (blockers.length && req.body.status !== 'todo') return res.status(400).json({ message: 'Task dependency not completed' });
  }

  const beforePriority = task.priority;
  ['title', 'description', 'category', 'project', 'department', 'branch', 'status', 'assignedTo', 'watchers', 'dependencies', 'recurring', 'qualityScore'].forEach(f => {
    if (req.body[f] !== undefined) task[f] = req.body[f];
  });

  if (req.body.priority !== undefined) {
    const priority = normalizePriority(req.body.priority);
    if (!priority) return res.status(400).json({ message: 'Priority required: urgent/high/medium/low' });
    task.priority = priority;
    task.slaHours = priorityToSlaHours(priority);
    if (priority !== beforePriority) {
      task.dueDate = calculateDueDate({ startDate: task.startDate || task.createdAt || new Date(), priority, slaHours: task.slaHours });
      task.slaWarningSent = false;
      task.escalated = false;
    }
  }

  if (req.body.status === 'completed') task.completedAt = task.completedAt || new Date();
  addActivity(task, req.user, 'Task Updated', 'Task details updated');
  await task.save();
  await notifyMany([task.assignedTo, task.assignedBy, ...(task.watchers || [])], { title: 'Task Updated', message: `${task.title} was updated by ${req.user.name}`, type: 'task', refType: 'Task', refId: task._id, channels: ['dashboard'] });
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.delete('/:id', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  await task.deleteOne();
  res.json({ message: 'Task deleted' });
});

router.patch('/:id/status', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  if (taskIsClosed(task)) return res.status(400).json({ message: 'Approved/closed task cannot change status' });
  if (!taskStatuses.includes(req.body.status)) return res.status(400).json({ message: 'Invalid status' });
  if (task.dependencies?.length && req.body.status !== 'todo') {
    const blockers = await Task.find({ _id: { $in: task.dependencies }, status: { $ne: 'completed' } });
    if (blockers.length) return res.status(400).json({ message: 'Task B can start only after dependent Task A is completed' });
  }

  const oldStatus = task.status;
  task.status = req.body.status;

  if (req.body.status === 'inProgress') {
    const running = task.timeLogs.find(t => String(t.user) === String(req.user._id) && !t.end);
    if (!running) task.timeLogs.push({ user: req.user._id, start: new Date(), note: 'Auto started when status changed to In Progress' });
    addActivity(task, req.user, 'Timer Auto Started', 'Official timer started when task moved to In Progress');
  }

  if (req.body.status === 'completed') {
    task.completedAt = task.completedAt || new Date();
    task.timeLogs.forEach(t => {
      if (!t.end) {
        t.end = new Date();
        t.minutes = Math.max(1, Math.round((t.end - t.start) / 60000));
      }
    });
  }

  addActivity(task, req.user, 'Status Changed', `Status changed from ${oldStatus} to ${req.body.status}`);
  await task.save();

  if (req.body.status === 'inProgress') {
    const recipients = await managerRecipientsForTask(task, req.user._id);
    await notifyMany(recipients, { title: 'Task Started', message: `${req.user.name} started ${task.title}. SLA closes at ${task.dueDate.toLocaleString()}.`, type: 'task', refType: 'Task', refId: task._id, channels: ['dashboard'] });
  }

  await notifyMany([task.assignedTo, task.assignedBy, ...(task.watchers || [])].filter(Boolean), {
    title: 'Task Status Updated',
    message: `${req.user.name} changed ${task.title} to ${req.body.status}`,
    type: 'task',
    refType: 'Task',
    refId: task._id,
    channels: ['dashboard']
  });
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.post('/:id/comments', readOnlyBlock, upload.array('files', 5), async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canViewTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  const message = cleanText(req.body.message);
  if (!message) return res.status(400).json({ message: 'Comment message required' });
  const attachments = await Promise.all((req.files || []).map(f => fileToAttachment(f, req.user)));
  task.comments.push({ user: req.user._id, message, attachments });
  addActivity(task, req.user, 'Comment Added', message);
  await task.save();
  await notifyMany([task.assignedTo, task.assignedBy, ...(task.watchers || [])].filter(id => String(id) !== String(req.user._id)), { title: 'New Task Comment', message, type: 'comment', refType: 'Task', refId: task._id, channels: ['dashboard', 'email'] });
  res.status(201).json({ task: await populateTask(Task.findById(task._id)) });
});

router.post('/:id/attachments', readOnlyBlock, upload.array('files', 10), async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canViewTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  const attachments = await Promise.all((req.files || []).map(f => fileToAttachment(f, req.user)));
  task.attachments.push(...attachments);
  addActivity(task, req.user, 'Files Uploaded', `${attachments.length} file(s) uploaded`);
  await task.save();
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.post('/:id/subtasks', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  task.subtasks.push({ title: req.body.title, assignedTo: req.body.assignedTo || task.assignedTo, dueDate: task.dueDate });
  addActivity(task, req.user, 'Subtask Added', req.body.title);
  await task.save();
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.put('/:id/subtasks/:subtaskId', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  const sub = task.subtasks.id(req.params.subtaskId);
  if (!sub) return res.status(404).json({ message: 'Subtask not found' });
  Object.assign(sub, req.body);
  if (req.body.status === 'completed') sub.completedAt = new Date();
  addActivity(task, req.user, 'Subtask Updated', sub.title);
  await task.save();
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.post('/:id/extension', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canViewTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  const requestedHours = Number(req.body.requestedHours || 0);
  if (![1, 2, 4, 6, 8].includes(requestedHours)) return res.status(400).json({ message: 'Select requested extra official hours' });
  const requestedDueDate = calculateDueDate({ startDate: task.dueDate || new Date(), priority: 'medium', slaHours: requestedHours });
  task.extensionRequests.push({ requestedBy: req.user._id, currentDueDate: task.dueDate, requestedDueDate, requestedHours, reason: req.body.reason || 'Need more time' });
  addActivity(task, req.user, 'Extension Requested', `${requestedHours} extra official hour(s)`);
  await task.save();
  const recipients = await managerRecipientsForTask(task, req.user._id);
  await notifyMany(recipients, { title: 'Deadline Extension Request', message: `${req.user.name} requested ${requestedHours} extra official hour(s) for ${task.title}`, type: 'deadline', refType: 'Task', refId: task._id, channels: ['dashboard', 'email'] });
  res.status(201).json({ task: await populateTask(Task.findById(task._id)) });
});

async function resolveExtensionRequest(req, res) {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  const ext = task.extensionRequests.id(req.params.requestId);
  if (!ext) return res.status(404).json({ message: 'Extension request not found' });
  const decision = req.body.status || req.body.decision;
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ message: 'Status must be approved or rejected' });
  ext.status = decision;
  ext.reviewedBy = req.user._id;
  ext.reviewComment = req.body.reviewComment || '';
  ext.reviewedAt = new Date();
  if (decision === 'approved') {
    task.dueDate = ext.requestedDueDate;
    task.slaWarningSent = false;
    task.escalated = false;
    if (task.status === 'overdue') task.status = 'inProgress';
  }
  addActivity(task, req.user, `Extension ${decision}`, ext.reviewComment);
  await task.save();
  await notifyUser({ userId: ext.requestedBy, title: `Extension Request ${decision}`, message: `${task.title} extension request ${decision}.`, type: 'deadline', refType: 'Task', refId: task._id, channels: ['dashboard', 'email'] });
  res.json({ task: await populateTask(Task.findById(task._id)) });
}

router.put('/:id/extension/:requestId', readOnlyBlock, resolveExtensionRequest);
router.patch('/:id/extension/:requestId', readOnlyBlock, resolveExtensionRequest);

router.post('/:id/submit', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  task.approvalStatus = 'submitted';
  task.status = 'review';
  addActivity(task, req.user, 'Submitted For Approval', 'Task submitted for manager/admin approval');
  await task.save();
  const reviewers = await managerRecipientsForTask(task, req.user._id);
  await notifyMany(reviewers, { title: 'Task Submitted For Approval', message: `${req.user.name} submitted ${task.title} for approval`, type: 'approval', refType: 'Task', refId: task._id, channels: ['dashboard', 'email'] });
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.post('/:id/review', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  task.approvalStatus = 'teamLeadReviewed';
  addActivity(task, req.user, 'Team Lead Reviewed', 'Team lead reviewed task');
  await task.save();
  const reviewers = await managerRecipientsForTask(task, req.user._id);
  await notifyMany(reviewers, { title: 'Task Reviewed By Team Lead', message: `${task.title} is ready for manager/admin approval`, type: 'approval', refType: 'Task', refId: task._id, channels: ['dashboard'] });
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.post('/:id/approve', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  task.approvalStatus = req.user.role === 'admin' ? 'adminApproved' : 'managerApproved';
  task.status = 'completed';
  task.completedAt = new Date();
  task.qualityScore = Number(req.body.qualityScore || task.qualityScore || 90);
  task.timeLogs.forEach(t => {
    if (!t.end) {
      t.end = new Date();
      t.minutes = Math.max(1, Math.round((t.end - t.start) / 60000));
    }
  });
  addActivity(task, req.user, 'Task Approved', req.body.comment || 'Approved');
  await task.save();
  await notifyUser({ userId: task.assignedTo, title: 'Task Approved And Closed', message: `${task.title} has been approved and closed`, type: 'approval', refType: 'Task', refId: task._id, channels: ['dashboard', 'email'] });
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.post('/:id/reject', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  task.approvalStatus = 'rejected';
  task.status = 'rejected';
  addActivity(task, req.user, 'Task Rejected', req.body.reason || 'Rejected');
  await task.save();
  await notifyUser({ userId: task.assignedTo, title: 'Task Rejected', message: `${task.title}: ${req.body.reason || 'Rejected'}`, type: 'approval', refType: 'Task', refId: task._id, channels: ['dashboard', 'email'] });
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.post('/:id/time/start', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (!(await canModifyTask(req.user, task))) return res.status(403).json({ message: 'Permission denied' });
  const running = task.timeLogs.find(t => String(t.user) === String(req.user._id) && !t.end);
  if (running) return res.status(400).json({ message: 'Timer already running' });
  task.timeLogs.push({ user: req.user._id, start: new Date(), note: req.body.note || '' });
  if (task.status === 'todo') task.status = 'inProgress';
  addActivity(task, req.user, 'Timer Started');
  await task.save();
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

router.post('/:id/time/stop', readOnlyBlock, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  const running = task.timeLogs.find(t => String(t.user) === String(req.user._id) && !t.end);
  if (!running) return res.status(400).json({ message: 'No running timer found' });
  running.end = new Date();
  running.minutes = Math.max(1, Math.round((running.end - running.start) / 60000));
  addActivity(task, req.user, 'Timer Stopped', `${running.minutes} minutes`);
  await task.save();
  res.json({ task: await populateTask(Task.findById(task._id)) });
});

export default router;
