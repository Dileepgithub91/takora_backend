import Task from '../models/Task.js';
import { notifyMany, notifyUser } from './notifications.js';
import { managerRecipientsForTask, refreshOverdueTasks, visibleSlaLabel } from './sla.js';

export async function runAutomation() {
  const overdueMarked = await refreshOverdueTasks();
  const now = new Date();
  let escalated = 0;

  const overdueTasks = await Task.find({
    status: 'overdue',
    approvalStatus: { $nin: ['adminApproved', 'managerApproved'] }
  }).populate('assignedTo assignedBy', 'name email role reportingManager department');

  for (const task of overdueTasks) {
    if (!task.escalated) {
      const recipients = await managerRecipientsForTask(task, task.assignedTo?._id);
      if (recipients.length) {
        task.escalated = true;
        task.escalatedTo = recipients[0];
        task.escalationAt = now;
        task.activityLog.push({ actor: recipients[0], action: 'Auto Escalation', detail: 'Overdue task escalated to manager/admin.' });
        escalated += 1;
        await task.save();
        await notifyMany(recipients, {
          title: 'Auto Escalation',
          message: `${task.title} crossed ${visibleSlaLabel(task.priority)} SLA and needs action.`,
          type: 'deadline',
          refType: 'Task',
          refId: task._id,
          channels: ['dashboard', 'email']
        });
      }
    }
  }

  const warningWindow = new Date(now.getTime() + 30 * 60 * 1000);
  const dueSoon = await Task.find({
    status: { $in: ['todo', 'inProgress'] },
    approvalStatus: { $nin: ['adminApproved', 'managerApproved'] },
    dueDate: { $gte: now, $lte: warningWindow },
    slaWarningSent: false
  });

  for (const task of dueSoon) {
    task.slaWarningSent = true;
    task.activityLog.push({ actor: task.assignedTo, action: 'SLA Warning', detail: 'Official SLA reminder sent before due time.' });
    await task.save();
    await notifyUser({ userId: task.assignedTo, title: 'SLA Deadline Reminder', message: `${task.title} is close to SLA deadline.`, type: 'deadline', refType: 'Task', refId: task._id, channels: ['dashboard', 'email'] });
    const recipients = await managerRecipientsForTask(task, task.assignedTo);
    await notifyMany(recipients, { title: 'SLA Warning', message: `${task.title} will cross SLA soon.`, type: 'deadline', refType: 'Task', refId: task._id, channels: ['dashboard'] });
  }

  return { overdueMarked, escalated, dueSoonWarnings: dueSoon.length };
}
