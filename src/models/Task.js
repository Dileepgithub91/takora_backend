import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema({
  filename: String,
  originalName: String,
  path: String,
  mimetype: String,
  size: Number,
  storage: { type: String, enum: ['local', 's3'], default: 's3' },
  fileKey: String,
  downloadUrl: String,
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  uploadedAt: { type: Date, default: Date.now }
}, { _id: true });

const commentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  message: { type: String, required: true },
  attachments: [attachmentSchema],
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const subtaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  status: { type: String, enum: ['todo', 'inProgress', 'review', 'completed'], default: 'todo' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dueDate: Date,
  completedAt: Date
}, { timestamps: true });

const extensionSchema = new mongoose.Schema({
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  currentDueDate: Date,
  requestedDueDate: Date,
  requestedHours: { type: Number, default: 0 },
  reason: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewComment: String,
  reviewedAt: Date
}, { timestamps: true });

const timeLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  start: Date,
  end: Date,
  minutes: { type: Number, default: 0 },
  note: String
}, { _id: true });

const activitySchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: String,
  detail: String,
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const taskSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  category: { type: String, default: 'General' },
  project: { type: String, default: 'Takora Mart' },
  department: { type: String, default: 'General' },
  branch: { type: String, default: 'Thrissur' },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  status: { type: String, enum: ['todo', 'inProgress', 'review', 'completed', 'overdue', 'cancelled', 'rejected'], default: 'todo' },
  approvalStatus: { type: String, enum: ['notSubmitted', 'submitted', 'teamLeadReviewed', 'managerApproved', 'adminApproved', 'rejected'], default: 'notSubmitted' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  watchers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  startDate: { type: Date, default: Date.now },
  dueDate: { type: Date, required: true },
  completedAt: Date,
  slaHours: { type: Number, default: 24 },
  slaWarningSent: { type: Boolean, default: false },
  escalated: { type: Boolean, default: false },
  escalatedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  escalationAt: Date,
  dependencies: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Task' }],
  subtasks: [subtaskSchema],
  comments: [commentSchema],
  attachments: [attachmentSchema],
  extensionRequests: [extensionSchema],
  timeLogs: [timeLogSchema],
  recurring: {
    enabled: { type: Boolean, default: false },
    frequency: { type: String, enum: ['daily', 'weekly', 'monthly', 'none'], default: 'none' },
    nextRunAt: Date
  },
  templateName: String,
  qualityScore: { type: Number, default: 0 },
  activityLog: [activitySchema]
}, { timestamps: true });

taskSchema.index({ title: 'text', description: 'text', category: 'text' });

export default mongoose.model('Task', taskSchema);
