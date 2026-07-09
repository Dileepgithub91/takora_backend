import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  category: {
    type: String,
    enum: ['SOP', 'Product Rules', 'Vendor Agreement', 'Invoice', 'Screenshot', 'Company Document', 'Other'],
    default: 'Other'
  },
  description: { type: String, default: '' },
  department: { type: String, default: 'All' },

  // Backward-compatible local fields. Old uploaded files may have these values.
  filename: String,
  originalName: String,
  path: String,
  mimetype: String,
  size: Number,

  // Permanent hosted storage fields.
  storage: { type: String, enum: ['local', 's3'], default: 's3' },
  fileKey: String,
  fileName: String,
  mimeType: String,

  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

export default mongoose.model('Document', documentSchema);
