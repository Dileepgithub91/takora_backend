import express from 'express';
import PDFDocument from 'pdfkit';
import xlsx from 'xlsx';
import Task from '../models/Task.js';
import Ticket from '../models/Ticket.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import { protect } from '../middleware/auth.js';
import { accessibleUserIds, taskQueryForUser } from '../utils/accessControl.js';
import { refreshOverdueTasks } from '../utils/sla.js';

const router = express.Router();
router.use(protect);

async function buildDashboard(user) {
  await refreshOverdueTasks(await taskQueryForUser(user));
  const ids = await accessibleUserIds(user);
  const taskQuery = await taskQueryForUser(user);
  const userQuery = ['admin', 'auditor'].includes(user.role) ? {} : { _id: { $in: ids } };
  const users = await User.find(userQuery).select('_id name role department status workStatus');
  const taskMatch = { ...taskQuery };
  const tasks = await Task.find(taskMatch).populate('assignedTo', 'name role department workStatus');
  const tickets = await Ticket.find(['admin', 'auditor'].includes(user.role) ? {} : { $or: [{ assignedTo: { $in: ids } }, { createdBy: user._id }, { department: user.department }] });
  const departments = await Department.countDocuments({ isActive: true });
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
  const weekStart = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000); weekStart.setHours(0,0,0,0);

  const count = (fn) => tasks.filter(fn).length;
  const widgets = {
    totalEmployees: users.length,
    activeEmployees: users.filter(u => u.status === 'active').length,
    inactiveEmployees: users.filter(u => u.status === 'inactive').length,
    totalDepartments: departments,
    totalProjects: new Set(tasks.map(t => t.project)).size,
    totalTasks: tasks.length,
    openTasks: count(t => !['completed', 'cancelled', 'rejected'].includes(t.status)),
    completedTasks: count(t => t.status === 'completed'),
    pendingTasks: count(t => ['todo', 'inProgress', 'review'].includes(t.status)),
    overdueTasks: count(t => t.status === 'overdue' || (t.dueDate < new Date() && !['completed', 'cancelled'].includes(t.status))),
    urgentTasks: count(t => t.priority === 'urgent'),
    todayTasks: count(t => t.dueDate >= todayStart && t.dueDate <= todayEnd),
    weekTasks: count(t => t.dueDate >= weekStart),
    openTickets: tickets.filter(t => !['closed','resolved'].includes(t.status)).length
  };

  const statusChart = ['todo','inProgress','review','completed','overdue','rejected'].map(status => ({ label: status, value: tasks.filter(t => t.status === status).length }));
  const priorityChart = ['low','medium','high','urgent'].map(priority => ({ label: priority, value: tasks.filter(t => t.priority === priority).length }));

  const employeePerformance = users.map(u => {
    const empTasks = tasks.filter(t => String(t.assignedTo?._id || t.assignedTo) === String(u._id));
    const completed = empTasks.filter(t => t.status === 'completed').length;
    const delayed = empTasks.filter(t => t.status === 'overdue' || (t.completedAt && t.completedAt > t.dueDate)).length;
    const pending = empTasks.filter(t => ['todo','inProgress','review'].includes(t.status)).length;
    const score = empTasks.length ? Math.max(0, Math.round((completed / empTasks.length) * 100 - delayed * 5)) : 0;
    const workload = empTasks.filter(t => !['completed','cancelled'].includes(t.status)).length;
    return { _id: u._id, name: u.name, role: u.role, department: u.department, workStatus: u.workStatus, total: empTasks.length, completed, pending, delayed, workload, productivityScore: score };
  });

  const departmentsList = [...new Set(users.map(u => u.department).filter(Boolean))];
  const departmentPerformance = departmentsList.map(dep => {
    const depTasks = tasks.filter(t => t.department === dep || t.assignedTo?.department === dep);
    return {
      department: dep,
      total: depTasks.length,
      completed: depTasks.filter(t => t.status === 'completed').length,
      pending: depTasks.filter(t => ['todo','inProgress','review'].includes(t.status)).length,
      overdue: depTasks.filter(t => t.status === 'overdue').length
    };
  });

  const overdueTrend = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000);
    const start = new Date(d); start.setHours(0,0,0,0);
    const end = new Date(d); end.setHours(23,59,59,999);
    return { date: start.toISOString().slice(0,10), overdue: tasks.filter(t => t.dueDate >= start && t.dueDate <= end && (t.status === 'overdue' || (t.dueDate < new Date() && t.status !== 'completed'))).length };
  });

  return { role: user.role, user: { _id: user._id, name: user.name, role: user.role, department: user.department }, widgets, statusChart, priorityChart, employeePerformance, departmentPerformance, overdueTrend, tickets: { total: tickets.length, open: widgets.openTickets } };
}

router.get('/dashboard', async (req, res) => {
  res.json(await buildDashboard(req.user));
});

router.get('/tasks', async (req, res) => {
  const q = await taskQueryForUser(req.user);
  if (req.query.period === 'daily') {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);
    q.createdAt = { $gte: start, $lte: end };
  }
  if (req.query.period === 'weekly') q.createdAt = { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
  if (req.query.period === 'monthly') q.createdAt = { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
  const tasks = await Task.find(q).populate('assignedTo assignedBy', 'name email role department').sort({ createdAt: -1 });
  res.json({ tasks });
});

router.get('/export', async (req, res) => {
  const data = await buildDashboard(req.user);
  const rows = data.employeePerformance.map(r => ({ Employee: r.name, Role: r.role, Department: r.department, Total: r.total, Completed: r.completed, Pending: r.pending, Delayed: r.delayed, Workload: r.workload, Score: r.productivityScore }));
  const format = req.query.format || 'xlsx';
  if (format === 'csv') {
    const csv = [Object.keys(rows[0] || {}).join(','), ...rows.map(r => Object.values(r).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=takora-task-report.csv');
    return res.send(csv);
  }
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=takora-task-report.pdf');
    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);
    doc.fontSize(18).text('Takora Mart Task Management Report', { align: 'center' });
    doc.moveDown();
    rows.forEach(r => doc.fontSize(10).text(`${r.Employee} | ${r.Department} | Total ${r.Total} | Completed ${r.Completed} | Pending ${r.Pending} | Delayed ${r.Delayed} | Score ${r.Score}`));
    doc.end();
    return;
  }
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(wb, ws, 'Employee Report');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=takora-task-report.xlsx');
  res.send(buffer);
});

export default router;
