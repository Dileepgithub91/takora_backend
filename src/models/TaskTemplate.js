import mongoose from 'mongoose';

const taskTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: String,
  category: { type: String, default: 'General' },
  department: { type: String, default: 'General' },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  slaHours: { type: Number, default: 24 },
  subtasks: [{ title: String }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

export default mongoose.model('TaskTemplate', taskTemplateSchema);
