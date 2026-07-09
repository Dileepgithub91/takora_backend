import Task from '../models/Task.js';
import User from '../models/User.js';
import { notifyMany, notifyUser } from './notifications.js';

export const PRIORITY_SLA_HOURS = {
  urgent: 1,
  high: 2,
  medium: 4,
  low: 6
};

export const OFFICE_START = { hour: 9, minute: 30 };
export const LUNCH_START = { hour: 13, minute: 0 };
export const LUNCH_END = { hour: 14, minute: 0 };
export const OFFICE_END = { hour: 18, minute: 0 };

const FIXED_NATIONAL_HOLIDAYS = new Set([
  '01-26', // Republic Day
  '08-15', // Independence Day
  '10-02'  // Gandhi Jayanti
]);

export function titleCase(value = '') {
  return String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function copyAt(date, hour, minute) {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function dateKey(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isWorkingDay(date) {
  if (date.getDay() === 0) return false; // Sunday
  if (FIXED_NATIONAL_HOLIDAYS.has(dateKey(date))) return false;
  return true;
}

export function nextWorkingStart(input = new Date()) {
  let d = new Date(input);
  d.setSeconds(0, 0);

  while (!isWorkingDay(d)) {
    d.setDate(d.getDate() + 1);
    d.setHours(OFFICE_START.hour, OFFICE_START.minute, 0, 0);
  }

  const officeStart = copyAt(d, OFFICE_START.hour, OFFICE_START.minute);
  const lunchStart = copyAt(d, LUNCH_START.hour, LUNCH_START.minute);
  const lunchEnd = copyAt(d, LUNCH_END.hour, LUNCH_END.minute);
  const officeEnd = copyAt(d, OFFICE_END.hour, OFFICE_END.minute);

  if (d < officeStart) return officeStart;
  if (d >= officeStart && d < lunchStart) return d;
  if (d >= lunchStart && d < lunchEnd) return lunchEnd;
  if (d >= lunchEnd && d < officeEnd) return d;

  d.setDate(d.getDate() + 1);
  d.setHours(OFFICE_START.hour, OFFICE_START.minute, 0, 0);
  return nextWorkingStart(d);
}

function currentSegmentEnd(date) {
  const lunchStart = copyAt(date, LUNCH_START.hour, LUNCH_START.minute);
  const officeEnd = copyAt(date, OFFICE_END.hour, OFFICE_END.minute);
  return date < lunchStart ? lunchStart : officeEnd;
}

export function addOfficialWorkingMinutes(input, minutesToAdd) {
  let d = nextWorkingStart(input);
  let remaining = Math.max(0, Math.round(Number(minutesToAdd) || 0));

  while (remaining > 0) {
    d = nextWorkingStart(d);
    const segmentEnd = currentSegmentEnd(d);
    const available = Math.max(0, Math.floor((segmentEnd - d) / 60000));

    if (remaining <= available) {
      return new Date(d.getTime() + remaining * 60000);
    }

    remaining -= available;
    d = new Date(segmentEnd.getTime() + 60000);
  }

  return d;
}

export function priorityToSlaHours(priority = 'medium') {
  return PRIORITY_SLA_HOURS[String(priority).toLowerCase()] || PRIORITY_SLA_HOURS.medium;
}

export function calculateDueDate({ startDate = new Date(), priority = 'medium', slaHours } = {}) {
  const hours = Number(slaHours || priorityToSlaHours(priority));
  return addOfficialWorkingMinutes(startDate, hours * 60);
}

export function visibleSlaLabel(priority = 'medium') {
  const h = priorityToSlaHours(priority);
  return `${h} Official Hour${h === 1 ? '' : 's'}`;
}

export function isClosedTask(task) {
  return ['completed', 'cancelled', 'rejected'].includes(task.status) || ['adminApproved', 'managerApproved'].includes(task.approvalStatus);
}

export async function managerRecipientsForTask(task, actorId = null) {
  const taskDoc = await Task.findById(task._id || task).select('assignedTo assignedBy department branch').lean();
  if (!taskDoc) return [];

  const [assignedUser, assignedByUser, admins, departmentLeads] = await Promise.all([
    User.findById(taskDoc.assignedTo).select('_id reportingManager department role').lean(),
    User.findById(taskDoc.assignedBy).select('_id reportingManager department role').lean(),
    User.find({ role: 'admin', status: 'active' }).select('_id').lean(),
    User.find({
      role: { $in: ['manager', 'teamLead'] },
      status: 'active',
      $or: [{ department: taskDoc.department }, { branch: taskDoc.branch }]
    }).select('_id').lean()
  ]);

  const ids = [
    taskDoc.assignedBy,
    assignedUser?.reportingManager,
    assignedByUser?.reportingManager,
    ...admins.map(u => u._id),
    ...departmentLeads.map(u => u._id)
  ];

  return [...new Set(ids.filter(Boolean).map(String))].filter(id => String(id) !== String(actorId || ''));
}

export async function refreshOverdueTasks(scopeQuery = {}) {
  const now = new Date();
  const q = {
    ...scopeQuery,
    dueDate: { $lt: now },
    status: { $nin: ['completed', 'cancelled', 'rejected', 'overdue'] },
    approvalStatus: { $nin: ['adminApproved', 'managerApproved'] }
  };

  const tasks = await Task.find(q).populate('assignedTo assignedBy', 'name email role reportingManager department');
  let changed = 0;

  for (const task of tasks) {
    task.status = 'overdue';
    task.activityLog.push({ actor: task.assignedTo?._id, action: 'SLA_OVERDUE', detail: 'Task crossed official SLA and color changed to overdue.' });
    changed += 1;
    await task.save();

    const recipients = await managerRecipientsForTask(task, task.assignedTo?._id);
    await notifyMany(recipients, {
      title: 'SLA Breach Alert',
      message: `${task.title} crossed ${visibleSlaLabel(task.priority)} SLA and is now overdue.`,
      type: 'deadline',
      refType: 'Task',
      refId: task._id,
      channels: ['dashboard', 'email']
    });
    if (task.assignedTo?._id) {
      await notifyUser({
        userId: task.assignedTo._id,
        title: 'Task Overdue',
        message: `${task.title} crossed official SLA. Please update or submit the task.`,
        type: 'deadline',
        refType: 'Task',
        refId: task._id,
        channels: ['dashboard', 'email', 'whatsapp', 'sms']
      });
    }
  }

  return changed;
}
