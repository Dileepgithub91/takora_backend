import mongoose from 'mongoose';

const ticketCommentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  message: String,
  createdAt: { type: Date, default: Date.now }
});

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
  status: { type: String, enum: ['open', 'inProgress', 'waiting', 'resolved', 'closed', 'escalated'], default: 'open' },
  department: { type: String, default: 'Customer Support' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  slaDueDate: Date,
  escalatedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  escalatedAt: Date,
  comments: [ticketCommentSchema],
  activityLog: [{ actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, action: String, detail: String, createdAt: { type: Date, default: Date.now } }]
}, { timestamps: true });

export default mongoose.model('Ticket', ticketSchema);
