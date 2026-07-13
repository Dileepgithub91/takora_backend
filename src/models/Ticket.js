import mongoose from 'mongoose';

const ticketAttachmentSchema = new mongoose.Schema({
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

const ticketCommentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  message: String,
  attachments: [ticketAttachmentSchema],
  createdAt: { type: Date, default: Date.now }
});

const ticketExtensionSchema = new mongoose.Schema({
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

const ticketSchema = new mongoose.Schema({
  ticketNo: { type: String, unique: true, index: true },
  source: { type: String, enum: ['customer', 'vendor', 'support', 'internal'], default: 'customer' },
  requesterName: { type: String, default: '' },
  requesterEmail: { type: String, default: '' },
  requesterPhone: { type: String, default: '' },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  category: { type: String, enum: ['websiteBug', 'customerComplaint', 'vendorIssue', 'employeeRequest', 'orderIssue', 'paymentIssue', 'other'], default: 'other' },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  slaHours: { type: Number, default: 6 },
  status: { type: String, enum: ['open', 'inProgress', 'waiting', 'resolved', 'closed', 'escalated', 'rejected'], default: 'open' },
  approvalStatus: {
    type: String,
    enum: ['notRequired', 'notSubmitted', 'pending', 'submitted', 'approved', 'managerApproved', 'adminApproved', 'rejected'],
    default: 'notSubmitted'
  },
  department: { type: String, default: 'Customer Support' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  slaDueDate: Date,
  escalatedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  escalatedAt: Date,
  resolvedAt: Date,
  closedAt: Date,
  comments: [ticketCommentSchema],
  attachments: [ticketAttachmentSchema],
  extensionRequests: [ticketExtensionSchema],
  activityLog: [{ actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, action: String, detail: String, createdAt: { type: Date, default: Date.now } }]
}, { timestamps: true });

ticketSchema.index({ title: 'text', description: 'text', ticketNo: 'text', requesterName: 'text', requesterEmail: 'text' });
ticketSchema.index({ assignedTo: 1, status: 1, priority: 1, source: 1, createdAt: -1, slaDueDate: 1 });
ticketSchema.index({ department: 1, createdAt: -1 });

export default mongoose.model('Ticket', ticketSchema);
