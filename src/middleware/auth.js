import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Not authorized, token missing' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    const user = await User.findById(decoded.id);
    if (!user || user.status !== 'active') return res.status(401).json({ message: 'User inactive or not found' });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
}

export function permit(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ message: 'Permission denied' });
    next();
  };
}

export function readOnlyBlock(req, res, next) {
  if (req.user.role === 'auditor') return res.status(403).json({ message: 'Auditor has read-only access' });
  next();
}
