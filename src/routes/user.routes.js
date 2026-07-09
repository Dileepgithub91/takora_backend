import express from 'express';
import User from '../models/User.js';
import Task from '../models/Task.js';
import { protect, readOnlyBlock } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { accessibleUserIds, canManageUser, canViewUser } from '../utils/accessControl.js';
import { notifyUser } from '../utils/notifications.js';
import { uploadBufferToS3, getSignedS3Url } from '../utils/s3Upload.js';

const router = express.Router();
router.use(protect);

function cleanEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

async function ensureUniqueUserFields({ email, employeeId, excludeId = null }) {
  const clauses = [];
  const normalizedEmail = cleanEmail(email);
  const normalizedEmployeeId = String(employeeId || '').trim();

  if (normalizedEmail) clauses.push({ email: normalizedEmail });
  if (normalizedEmployeeId) clauses.push({ employeeId: normalizedEmployeeId });

  if (!clauses.length) return;

  const query = { $or: clauses };
  if (excludeId) query._id = { $ne: excludeId };

  const existing = await User.findOne(query).select('email employeeId');
  if (!existing) return;

  if (normalizedEmail && existing.email === normalizedEmail) {
    const error = new Error('Email ID already exists. Please use another email.');
    error.statusCode = 409;
    throw error;
  }

  if (normalizedEmployeeId && existing.employeeId === normalizedEmployeeId) {
    const error = new Error('Employee ID already exists. Please use another employee ID.');
    error.statusCode = 409;
    throw error;
  }
}


function removeSecrets(u) {
  const obj = u?.toObject ? u.toObject() : { ...(u || {}) };
  delete obj.password;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  return obj;
}

async function safeUser(u) {
  const obj = removeSecrets(u);

  if (obj.avatarKey) {
    obj.avatarUrl = await getSignedS3Url(obj.avatarKey);
  } else if (obj.avatar) {
    obj.avatarUrl = obj.avatar;
  } else {
    obj.avatarUrl = '';
  }

  return obj;
}

async function publicAssignableUser(u) {
  const user = await safeUser(u);
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department,
    branch: user.branch,
    designation: user.designation,
    employeeId: user.employeeId,
    phone: user.phone,
    whatsapp: user.whatsapp,
    avatar: user.avatar,
    avatarKey: user.avatarKey,
    avatarUrl: user.avatarUrl,
    workStatus: user.workStatus,
    status: user.status
  };
}

router.get('/assignable', async (req, res, next) => {
  try {
    const users = await User.find({ status: 'active' })
      .select('_id name email role department branch designation employeeId phone whatsapp avatar avatarKey workStatus status')
      .sort({ role: 1, department: 1, name: 1 });

    res.json({ users: await Promise.all(users.map(publicAssignableUser)) });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const ids = await accessibleUserIds(req.user);
    const query = req.user.role === 'admin' || req.user.role === 'auditor' ? {} : { _id: { $in: ids } };

    if (req.query.role) query.role = req.query.role;
    if (req.query.department) query.department = req.query.department;
    if (req.query.status) query.status = req.query.status;

    const users = await User.find(query)
      .populate('reportingManager', 'name email role')
      .sort({ role: 1, name: 1 });

    res.json({ users: await Promise.all(users.map(safeUser)) });
  } catch (error) {
    next(error);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    const ids = await accessibleUserIds(req.user);
    const query = req.user.role === 'admin' || req.user.role === 'auditor' ? {} : { _id: { $in: ids } };

    const users = await User.find(query)
      .select('_id name email role department status workStatus designation phone whatsapp reportingManager branch employeeId avatar avatarKey')
      .populate('reportingManager', 'name email role');

    const taskAgg = await Task.aggregate([
      { $match: { assignedTo: { $in: users.map(u => u._id) } } },
      {
        $group: {
          _id: '$assignedTo',
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          overdue: { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } }
        }
      }
    ]);

    const map = new Map(taskAgg.map(a => [String(a._id), a]));
    const signedUsers = await Promise.all(users.map(safeUser));

    res.json({
      users: signedUsers.map(u => ({
        ...u,
        taskSummary: map.get(String(u._id)) || { total: 0, completed: 0, overdue: 0 }
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.put('/me', readOnlyBlock, upload.single('avatar'), async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    ['name', 'phone', 'whatsapp', 'designation', 'workStatus'].forEach(f => {
      if (req.body[f] !== undefined) user[f] = req.body[f];
    });

    if (req.file) {
      const uploaded = await uploadBufferToS3(req.file, 'profile-images');
      user.avatarKey = uploaded.key;
      user.avatarOriginalName = uploaded.originalName;
      user.avatarMimeType = uploaded.mimetype;
      user.avatar = '';
    }

    await user.save();
    res.json({ user: await safeUser(user) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).populate('reportingManager', 'name email role');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!(await canViewUser(req.user, user))) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    const taskSummary = await Task.aggregate([
      { $match: { assignedTo: user._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    res.json({ user: await safeUser(user), taskSummary });
  } catch (error) {
    next(error);
  }
});

router.post('/', readOnlyBlock, async (req, res, next) => {
  try {
    if (!(await canManageUser(req.user))) {
      return res.status(403).json({ message: 'Only admin/manager/team lead can add team members' });
    }

    const allowedRolesByCreator = {
      admin: ['admin', 'manager', 'teamLead', 'employee', 'support', 'auditor'],
      manager: ['teamLead', 'employee', 'support'],
      teamLead: ['employee', 'support']
    };

    const role = req.body.role || 'employee';

    if (!allowedRolesByCreator[req.user.role]?.includes(role)) {
      return res.status(403).json({ message: 'You cannot create this role' });
    }

    await ensureUniqueUserFields({ email: req.body.email, employeeId: req.body.employeeId });

    const user = await User.create({
      name: req.body.name,
      email: cleanEmail(req.body.email),
      password: req.body.password || 'Admin@123',
      phone: req.body.phone || '',
      whatsapp: req.body.whatsapp || '',
      employeeId: req.body.employeeId || '',
      role,
      department: req.body.department || req.user.department || 'General',
      branch: req.body.branch || req.user.branch || 'Thrissur',
      designation: req.body.designation || '',
      reportingManager: req.body.reportingManager || (req.user.role !== 'admin' ? req.user._id : null),
      status: req.body.status || 'active',
      workStatus: req.body.workStatus || 'available'
    });

    await notifyUser({
      userId: user._id,
      title: 'Welcome to Takora Mart Task System',
      message: `Your account has been created. Email: ${user.email}`,
      type: 'system',
      channels: ['dashboard', 'email']
    });

    res.status(201).json({ user: await safeUser(user) });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', readOnlyBlock, async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!(await canManageUser(req.user, user))) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    await ensureUniqueUserFields({
      email: req.body.email,
      employeeId: req.body.employeeId,
      excludeId: user._id
    });

    const fields = ['name', 'email', 'phone', 'whatsapp', 'employeeId', 'role', 'department', 'branch', 'designation', 'reportingManager', 'status', 'workStatus', 'avatar'];

    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        if (f === 'email') user[f] = cleanEmail(req.body[f]);
        else user[f] = req.body[f] || (f === 'reportingManager' ? null : req.body[f]);
      }
    });

    if (req.body.password) user.password = req.body.password;

    await user.save();
    res.json({ user: await safeUser(user) });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', readOnlyBlock, async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!(await canManageUser(req.user, user))) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    user.status = 'inactive';
    await user.save();

    res.json({ message: 'User deactivated', user: await safeUser(user) });
  } catch (error) {
    next(error);
  }
});

export default router;
