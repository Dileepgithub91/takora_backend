import User from '../models/User.js';

const higherRoles = ['admin', 'manager', 'teamLead'];

export function isHigherLevel(user) {
  return higherRoles.includes(user.role);
}

export function isAdmin(user) {
  return user.role === 'admin';
}

export function isAuditor(user) {
  return user.role === 'auditor';
}

export async function getReporteeIds(userId) {
  const users = await User.find({ status: 'active' }).select('_id reportingManager department role');
  const byManager = new Map();
  users.forEach(u => {
    const key = String(u.reportingManager || 'none');
    if (!byManager.has(key)) byManager.set(key, []);
    byManager.get(key).push(u);
  });
  const result = [];
  const walk = (id) => {
    const children = byManager.get(String(id)) || [];
    children.forEach(child => {
      result.push(child._id);
      walk(child._id);
    });
  };
  walk(userId);
  return result.map(String);
}

export async function accessibleUserIds(user) {
  if (user.role === 'admin' || user.role === 'auditor') {
    const all = await User.find({}).select('_id');
    return all.map(u => String(u._id));
  }
  if (user.role === 'manager') {
    const sameDept = await User.find({ department: user.department }).select('_id');
    const reportees = await getReporteeIds(user._id);
    return [...new Set([String(user._id), ...sameDept.map(u => String(u._id)), ...reportees])];
  }
  if (user.role === 'teamLead') {
    const reportees = await getReporteeIds(user._id);
    return [...new Set([String(user._id), ...reportees])];
  }
  return [String(user._id)];
}

export async function canViewUser(requester, targetUser) {
  if (requester.role === 'admin' || requester.role === 'auditor') return true;
  if (String(requester._id) === String(targetUser._id)) return true;
  const ids = await accessibleUserIds(requester);
  return ids.includes(String(targetUser._id));
}

export async function canManageUser(requester, targetUser = null) {
  if (requester.role === 'admin') return true;
  if (!targetUser) return ['manager', 'teamLead'].includes(requester.role);
  if (requester.role === 'manager') return targetUser.department === requester.department && targetUser.role !== 'admin';
  if (requester.role === 'teamLead') return String(targetUser.reportingManager) === String(requester._id) && ['employee', 'support'].includes(targetUser.role);
  return false;
}

export async function canViewTask(user, task) {
  if (user.role === 'admin' || user.role === 'auditor') return true;
  const uid = String(user._id);
  if ([task.assignedTo, task.assignedBy].some(v => String(v?._id || v) === uid)) return true;
  if ((task.watchers || []).some(v => String(v?._id || v) === uid)) return true;
  const ids = await accessibleUserIds(user);
  return ids.includes(String(task.assignedTo?._id || task.assignedTo)) || ids.includes(String(task.assignedBy?._id || task.assignedBy));
}

export async function canModifyTask(user, task) {
  if (user.role === 'admin') return true;
  if (user.role === 'auditor') return false;
  const uid = String(user._id);
  if (String(task.assignedBy?._id || task.assignedBy) === uid) return true;
  if (String(task.assignedTo?._id || task.assignedTo) === uid) return true;
  const ids = await accessibleUserIds(user);
  return ['manager', 'teamLead'].includes(user.role) && ids.includes(String(task.assignedTo?._id || task.assignedTo));
}

export async function taskQueryForUser(user) {
  if (user.role === 'admin' || user.role === 'auditor') return {};
  const ids = await accessibleUserIds(user);
  return {
    $or: [
      { assignedTo: { $in: ids } },
      { assignedBy: user._id },
      { watchers: user._id }
    ]
  };
}
