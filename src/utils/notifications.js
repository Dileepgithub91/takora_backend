import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { sendMail } from './mailer.js';

function uniqueIds(userIds = []) {
  return [...new Set(userIds.filter(Boolean).map(String))];
}

async function appendDeliveryLog(notificationId, log) {
  try {
    await Notification.findByIdAndUpdate(notificationId, {
      $push: { deliveryLog: log },
      ...( ['sent', 'mock', 'dev-mode'].includes(log.status) ? { delivered: true } : {} )
    });
  } catch (error) {
    console.error('Notification delivery log update failed:', error.message);
  }
}

function deliverAsync(notification, user, { title, message, channels }) {
  const jobs = [];

  if (channels.includes('email') && process.env.ENABLE_EMAIL !== 'false' && user.email) {
    jobs.push(
      sendMail({
        to: user.email,
        subject: title,
        text: message,
        html: `<p>${message}</p>`,
        timeoutMs: Number(process.env.NOTIFICATION_EMAIL_TIMEOUT_MS || 6000)
      })
        .then(result => appendDeliveryLog(notification._id, {
          channel: 'email',
          status: result.sent ? 'sent' : 'dev-mode',
          detail: result.message || 'Email processed'
        }))
        .catch(error => appendDeliveryLog(notification._id, {
          channel: 'email',
          status: 'failed',
          detail: error.message
        }))
    );
  }

  if (channels.includes('whatsapp') && process.env.ENABLE_WHATSAPP_MOCK !== 'false') {
    jobs.push(appendDeliveryLog(notification._id, {
      channel: 'whatsapp',
      status: 'mock',
      detail: `Mock WhatsApp to ${user.whatsapp || user.phone || user.email}`
    }));
  }

  if (channels.includes('sms') && process.env.ENABLE_SMS_MOCK !== 'false') {
    jobs.push(appendDeliveryLog(notification._id, {
      channel: 'sms',
      status: 'mock',
      detail: `Mock SMS to ${user.phone || user.email}`
    }));
  }

  Promise.allSettled(jobs).catch(error => console.error('Notification background delivery failed:', error.message));
}

export async function notifyUser({ userId, title, message, type = 'system', refType = '', refId = null, channels = ['dashboard'] }) {
  const user = await User.findById(userId).select('_id name email phone whatsapp');
  if (!user) return null;

  const notification = await Notification.create({
    user: user._id,
    title,
    message,
    type,
    refType,
    refId,
    channels,
    delivered: channels.includes('dashboard'),
    deliveryLog: channels.includes('dashboard')
      ? [{ channel: 'dashboard', status: 'sent', detail: 'Dashboard notification created' }]
      : []
  });

  deliverAsync(notification, user, { title, message, channels });
  return notification;
}

export async function notifyMany(userIds, payload) {
  const ids = uniqueIds(userIds);
  return Promise.all(ids.map(id => notifyUser({ userId: id, ...payload })));
}
