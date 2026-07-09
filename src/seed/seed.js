import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import User from '../models/User.js';
import Task from '../models/Task.js';
import Ticket from '../models/Ticket.js';
import Department from '../models/Department.js';
import Notification from '../models/Notification.js';
import Document from '../models/Document.js';
import TaskTemplate from '../models/TaskTemplate.js';

await connectDB();
await Promise.all([
  User.deleteMany({}), Task.deleteMany({}), Ticket.deleteMany({}), Department.deleteMany({}), Notification.deleteMany({}), Document.deleteMany({}), TaskTemplate.deleteMany({})
]);

const password = 'Admin@123';
const admin = await User.create({ name: 'Takora Admin', email: 'admin@takoramart.com', password, role: 'admin', department: 'Management', designation: 'System Admin', employeeId: 'TM001', phone: '9137576821', whatsapp: '9137576821' });
const manager = await User.create({ name: 'Marketing Manager', email: 'manager@takoramart.com', password, role: 'manager', department: 'Marketing', designation: 'Department Manager', reportingManager: admin._id, employeeId: 'TM002', phone: '9000000002' });
const lead = await User.create({ name: 'Team Lead', email: 'lead@takoramart.com', password, role: 'teamLead', department: 'Marketing', designation: 'Team Lead', reportingManager: manager._id, employeeId: 'TM003', phone: '9000000003' });
const marketing = await User.create({ name: 'Marketing Executive', email: 'marketing@takoramart.com', password, role: 'employee', department: 'Marketing', designation: 'Marketing Executive', reportingManager: lead._id, employeeId: 'TM004', phone: '9000000004' });
const support = await User.create({ name: 'Customer Support', email: 'support@takoramart.com', password, role: 'support', department: 'Customer Support', designation: 'Support Executive', reportingManager: manager._id, employeeId: 'TM005', phone: '9000000005' });
const accounts = await User.create({ name: 'Accounts Executive', email: 'accounts@takoramart.com', password, role: 'employee', department: 'Accounts', designation: 'Accounts Executive', reportingManager: admin._id, employeeId: 'TM006', phone: '9000000006' });
const auditor = await User.create({ name: 'Auditor', email: 'auditor@takoramart.com', password, role: 'auditor', department: 'Audit', designation: 'Auditor', reportingManager: admin._id, employeeId: 'TM007' });

await Department.insertMany([
  { name: 'Management', code: 'MGT', manager: admin._id },
  { name: 'Marketing', code: 'MKT', manager: manager._id },
  { name: 'Customer Support', code: 'CS', manager: manager._id },
  { name: 'Accounts', code: 'ACC', manager: admin._id },
  { name: 'Product Listing', code: 'PL', manager: manager._id }
]);

await TaskTemplate.insertMany([
  { name: 'Product Upload', description: 'Create product listing with images, HSN, price, stock and specifications.', category: 'Product Listing', department: 'Product Listing', priority: 'high', slaHours: 24, createdBy: admin._id, subtasks: [{ title: 'Collect product images' }, { title: 'Add HSN and GST' }, { title: 'Write specifications' }, { title: 'Publish listing' }] },
  { name: 'Vendor Onboarding', description: 'Contact vendor, collect documents, upload catalogue and create seller profile.', category: 'Vendor', department: 'Marketing', priority: 'medium', slaHours: 48, createdBy: manager._id, subtasks: [{ title: 'Call vendor' }, { title: 'Collect GST details' }, { title: 'Collect price list' }, { title: 'Create vendor account' }] },
  { name: 'Order Complaint', description: 'Investigate customer complaint and close with resolution.', category: 'Customer Support', department: 'Customer Support', priority: 'urgent', slaHours: 8, createdBy: manager._id, subtasks: [{ title: 'Check order' }, { title: 'Call customer' }, { title: 'Resolve issue' }] }
]);

const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

const t1 = await Task.create({ title: 'Upload Kerala Naturals honey product', description: 'Create product details, images and pricing for honey.', category: 'Product Listing', project: 'Takora Mart', department: 'Product Listing', priority: 'high', status: 'inProgress', assignedTo: marketing._id, assignedBy: lead._id, watchers: [manager._id], dueDate: tomorrow, slaHours: 24, subtasks: [{ title: 'Prepare images', assignedTo: marketing._id }, { title: 'Add HSN/GST', assignedTo: marketing._id }], activityLog: [{ actor: lead._id, action: 'TASK_CREATED', detail: 'Seed task' }] });
const t2 = await Task.create({ title: 'Vendor follow-up for notebooks', description: 'Call notebook vendors and collect wholesale catalogue.', category: 'Vendor', project: 'Vendor Acquisition', department: 'Marketing', priority: 'medium', status: 'todo', assignedTo: marketing._id, assignedBy: manager._id, dueDate: nextWeek, slaHours: 48, recurring: { enabled: true, frequency: 'weekly' }, activityLog: [{ actor: manager._id, action: 'TASK_CREATED', detail: 'Seed task' }] });
const t3 = await Task.create({ title: 'Resolve payment ticket escalation', description: 'Check pending vendor payment ticket.', category: 'Ticket', project: 'Support', department: 'Customer Support', priority: 'urgent', status: 'overdue', assignedTo: support._id, assignedBy: manager._id, dueDate: yesterday, slaHours: 8, escalated: true, escalatedTo: admin._id, activityLog: [{ actor: manager._id, action: 'TASK_CREATED', detail: 'Seed overdue task' }] });
const t4 = await Task.create({ title: 'Prepare monthly GST invoice report', description: 'Export tax invoice data and submit.', category: 'Accounts', project: 'Finance', department: 'Accounts', priority: 'high', status: 'completed', approvalStatus: 'managerApproved', assignedTo: accounts._id, assignedBy: admin._id, dueDate: tomorrow, completedAt: new Date(), qualityScore: 95, activityLog: [{ actor: accounts._id, action: 'TASK_APPROVED', detail: 'Seed completed task' }] });

await Ticket.create({ ticketNo: 'TKR-00001', source: 'customer', requesterName: 'Customer Demo', requesterEmail: 'customer@example.com', requesterPhone: '9999999999', title: 'Customer order delivery delay', description: 'Customer says order is delayed.', category: 'orderIssue', priority: 'high', status: 'open', department: 'Customer Support', assignedTo: support._id, createdBy: manager._id, slaDueDate: tomorrow, activityLog: [{ actor: manager._id, action: 'TICKET_CREATED', detail: 'Seed ticket' }] });
await Ticket.create({ ticketNo: 'TKR-00002', source: 'vendor', requesterName: 'Vendor Demo', requesterEmail: 'vendor@example.com', requesterPhone: '8888888888', title: 'Vendor catalogue upload issue', description: 'Vendor cannot upload price list.', category: 'vendorIssue', priority: 'medium', status: 'inProgress', department: 'Marketing', assignedTo: marketing._id, createdBy: lead._id, slaDueDate: nextWeek, activityLog: [{ actor: lead._id, action: 'TICKET_CREATED', detail: 'Seed ticket' }] });

await Notification.insertMany([
  { user: marketing._id, title: 'New task assigned', message: 'Upload Kerala Naturals honey product', type: 'task', channels: ['dashboard'], refType: 'Task', refId: t1._id },
  { user: support._id, title: 'Urgent overdue task', message: 'Resolve payment ticket escalation', type: 'deadline', channels: ['dashboard'], refType: 'Task', refId: t3._id }
]);

console.log('Seed completed. Demo password for all users: Admin@123');
console.table([
  ['Admin', 'admin@takoramart.com'],
  ['Manager', 'manager@takoramart.com'],
  ['Team Lead', 'lead@takoramart.com'],
  ['Employee', 'marketing@takoramart.com'],
  ['Support', 'support@takoramart.com'],
  ['Accounts', 'accounts@takoramart.com'],
  ['Auditor', 'auditor@takoramart.com']
]);
await mongoose.disconnect();
