import express from 'express';
import crypto from 'crypto';
import User from '../models/User.js';
import { signToken } from '../utils/jwt.js';
import { protect, permit } from '../middleware/auth.js';
import { sendMail, isSmtpConfigured, isEmailEnabled, smtpStatus } from '../utils/mailer.js';
import { getSignedS3Url } from '../utils/s3Upload.js';

const router = express.Router();

function frontendUrl() {
  return String(process.env.FRONTEND_URL || 'http://localhost:5173').trim().replace(/\/$/, '');
}

async function publicUser(user) {
  let avatarUrl = '';

  if (user.avatarKey) {
    try {
      avatarUrl = await getSignedS3Url(user.avatarKey);
    } catch {
      avatarUrl = '';
    }
  } else if (user.avatar && String(user.avatar).startsWith('http')) {
    avatarUrl = user.avatar;
  }

  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department,
    branch: user.branch,
    phone: user.phone,
    whatsapp: user.whatsapp,
    employeeId: user.employeeId,
    designation: user.designation,
    workStatus: user.workStatus,
    status: user.status,
    avatar: user.avatar || '',
    avatarKey: user.avatarKey || '',
    avatarUrl,
    reportingManager: user.reportingManager
  };
}


router.get('/smtp-status', protect, permit('admin'), (req, res) => {
  res.json({ smtp: smtpStatus(), frontendUrl: frontendUrl() });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: String(email || '').toLowerCase() }).select('+password');

  if (!user || !(await user.matchPassword(password))) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ message: 'Your account is inactive. Contact admin.' });
  }

  user.lastLoginAt = new Date();
  await user.save();

  res.json({ token: signToken(user), user: await publicUser(user) });
});

router.get('/me', protect, async (req, res) => {
  const user = await User.findById(req.user._id).populate('reportingManager', 'name email role department');
  res.json({ user: await publicUser(user) });
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const safeMessage = 'If the email exists, a password reset link has been sent.';

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await User.findOne({ email }).select('+passwordResetToken +passwordResetExpires');

    if (!user || user.status !== 'active') {
      return res.json({ message: safeMessage });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.passwordResetToken = hashed;
    user.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    const resetLink = `${frontendUrl()}/reset-password/${rawToken}`;
    const result = await sendMail({
      to: user.email,
      subject: 'Takora Mart Task System - Reset Password',
      text: `Reset your Takora Mart Task System password using this link: ${resetLink}\nThis link expires in 30 minutes.`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
          <h2>Takora Mart Task System</h2>
          <p>We received a request to reset your password.</p>
          <p>This link expires in <b>30 minutes</b>.</p>
          <p>
            <a href="${resetLink}" style="background:#2563eb;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">
              Reset Password
            </a>
          </p>
          <p>If the button does not work, copy and paste this link:</p>
          <p>${resetLink}</p>
        </div>
      `,
      timeoutMs: Number(process.env.FORGOT_PASSWORD_EMAIL_TIMEOUT_MS || 20000)
    });

    const emailReady = isSmtpConfigured() && isEmailEnabled();
    const isProduction = process.env.NODE_ENV === 'production';

    res.json({
      message: emailReady
        ? 'Password reset link sent to email.'
        : (isProduction
          ? safeMessage
          : 'SMTP not configured/enabled. Reset link printed in backend terminal and returned for local development.'),
      devResetLink: !emailReady && !isProduction ? resetLink : undefined,
      mail: { sent: result.sent, devMode: result.devMode || false }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-password/:token', async (req, res) => {
  const hashed = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const user = await User.findOne({
    passwordResetToken: hashed,
    passwordResetExpires: { $gt: new Date() }
  }).select('+passwordResetToken +passwordResetExpires +password');

  if (!user) {
    return res.status(400).json({ message: 'Reset link is invalid or expired' });
  }

  if (!req.body.password || req.body.password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  user.password = req.body.password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  res.json({ message: 'Password reset successful. Please login.' });
});

router.post('/test-email', protect, permit('admin'), async (req, res, next) => {
  try {
    const to = req.body.to || req.user.email;
    const result = await sendMail({
      to,
      subject: 'Takora Mart SMTP Test',
      text: 'Takora Mart Task System SMTP is working.',
      html: '<p>Takora Mart Task System SMTP is working.</p>'
    });

    res.json({ message: result.sent ? 'Test email sent' : 'Test email processed in dev mode', mail: result });
  } catch (error) {
    next(error);
  }
});

export default router;
