import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ['task', 'ticket', 'comment', 'deadline', 'approval', 'system', 'password'], default: 'system' },
  channels: [{ type: String, enum: ['dashboard', 'email', 'whatsapp', 'sms'] }],
  refType: { type: String, default: '' },
  refId: { type: mongoose.Schema.Types.ObjectId, default: null },
  isRead: { type: Boolean, default: false },
  delivered: { type: Boolean, default: false },
  deliveryLog: [{ channel: String, status: String, detail: String, at: { type: Date, default: Date.now } }]
}, { timestamps: true });

export default mongoose.model('Notification', notificationSchema);
