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

// India has a fixed UTC+05:30 offset.  We calculate SLA with this offset
// directly so Render/local/server TZ differences cannot change due dates.
const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

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

function toIstDate(input = new Date()) {
  return new Date(new Date(input).getTime() + IST_OFFSET_MS);
}

function fromIstDate(istDate) {
  return new Date(istDate.getTime() - IST_OFFSET_MS);
}

function cloneUtc(date) {
  return new Date(date.getTime());
}

function copyAtUtc(date, hour, minute) {
  const d = cloneUtc(date);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

function dateKeyUtc(date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function isWorkingDay(date) {
  const ist = toIstDate(date);
  if (ist.getUTCDay() === 0) return false; // Sunday in India
  if (FIXED_NATIONAL_HOLIDAYS.has(dateKeyUtc(ist))) return false;
  return true;
}

function isWorkingDayIst(istDate) {
  if (istDate.getUTCDay() === 0) return false;
  if (FIXED_NATIONAL_HOLIDAYS.has(dateKeyUtc(istDate))) return false;
  return true;
}

export function nextWorkingStart(input = new Date()) {
  let d = toIstDate(input);
  d.setUTCSeconds(0, 0);

  while (!isWorkingDayIst(d)) {
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(OFFICE_START.hour, OFFICE_START.minute, 0, 0);
  }

  const officeStart = copyAtUtc(d, OFFICE_START.hour, OFFICE_START.minute);
  const lunchStart = copyAtUtc(d, LUNCH_START.hour, LUNCH_START.minute);
  const lunchEnd = copyAtUtc(d, LUNCH_END.hour, LUNCH_END.minute);
  const officeEnd = copyAtUtc(d, OFFICE_END.hour, OFFICE_END.minute);

  if (d < officeStart) return fromIstDate(officeStart);
  if (d >= officeStart && d < lunchStart) return fromIstDate(d);
  if (d >= lunchStart && d < lunchEnd) return fromIstDate(lunchEnd);
  if (d >= lunchEnd && d < officeEnd) return fromIstDate(d);

  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(OFFICE_START.hour, OFFICE_START.minute, 0, 0);
  return nextWorkingStart(fromIstDate(d));
}

function currentSegmentEndIst(istDate) {
  const lunchStart = copyAtUtc(istDate, LUNCH_START.hour, LUNCH_START.minute);
  const officeEnd = copyAtUtc(istDate, OFFICE_END.hour, OFFICE_END.minute);
  return istDate < lunchStart ? lunchStart : officeEnd;
}

export function addOfficialWorkingMinutes(input, minutesToAdd) {
  let actual = nextWorkingStart(input);
  let d = toIstDate(actual);
  let remaining = Math.max(0, Math.round(Number(minutesToAdd) || 0));

  while (remaining > 0) {
    actual = nextWorkingStart(fromIstDate(d));
    d = toIstDate(actual);
    const segmentEnd = currentSegmentEndIst(d);
    const available = Math.max(0, Math.floor((segmentEnd - d) / 60000));

    if (remaining <= available) {
      return fromIstDate(new Date(d.getTime() + remaining * 60000));
    }

    remaining -= available;
    d = new Date(segmentEnd.getTime() + 60 * 1000);
  }

  return fromIstDate(d);
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

  const result = await Task.updateMany(q, {
    $set: { status: 'overdue' },
    $push: {
      activityLog: {
        action: 'SLA_OVERDUE',
        detail: 'Task crossed official SLA and color changed to overdue.',
        createdAt: now
      }
    }
  });

  return result.modifiedCount || 0;
}
