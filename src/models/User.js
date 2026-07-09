import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6, select: false },
  phone: { type: String, default: '' },
  whatsapp: { type: String, default: '' },
  employeeId: { type: String, default: '', trim: true },
  role: { type: String, enum: ['admin', 'manager', 'teamLead', 'employee', 'support', 'auditor'], default: 'employee' },
  department: { type: String, default: 'General' },
  branch: { type: String, default: 'Thrissur' },
  designation: { type: String, default: '' },
  reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  workStatus: { type: String, enum: ['available', 'busy', 'onLeave', 'offline'], default: 'available' },
  joiningDate: { type: Date, default: Date.now },
  avatar: { type: String, default: '' },
  avatarKey: { type: String, default: '' },
  avatarOriginalName: { type: String, default: '' },
  avatarMimeType: { type: String, default: '' },
  passwordResetToken: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  lastLoginAt: Date
}, { timestamps: true });

userSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: 'string', $gt: '' } } }
);


userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.matchPassword = function matchPassword(enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model('User', userSchema);
