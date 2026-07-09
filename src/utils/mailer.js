import nodemailer from 'nodemailer';

function env(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

export function isEmailEnabled() {
  return env('ENABLE_EMAIL', 'true').toLowerCase() !== 'false';
}

export function isSmtpConfigured() {
  return Boolean(env('SMTP_HOST') && env('SMTP_PORT') && env('SMTP_USER') && env('SMTP_PASS'));
}

export function smtpStatus() {
  return {
    ENABLE_EMAIL: isEmailEnabled() ? 'true' : 'false',
    SMTP_HOST: env('SMTP_HOST') || 'MISSING',
    SMTP_PORT: env('SMTP_PORT') || 'MISSING',
    SMTP_SECURE: env('SMTP_SECURE') || 'auto',
    SMTP_USER: env('SMTP_USER') ? 'SET' : 'MISSING',
    SMTP_PASS: env('SMTP_PASS') ? 'SET' : 'MISSING',
    MAIL_FROM: env('MAIL_FROM') || 'MISSING'
  };
}

export function createMailTransporter() {
  const port = Number(env('SMTP_PORT', '587'));
  const secure = env('SMTP_SECURE', String(port === 465)).toLowerCase() === 'true';

  return nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port,
    secure,
    requireTLS: port === 587,
    auth: {
      user: env('SMTP_USER'),
      pass: env('SMTP_PASS')
    },
    connectionTimeout: Number(env('SMTP_CONNECTION_TIMEOUT_MS', '12000')),
    greetingTimeout: Number(env('SMTP_GREETING_TIMEOUT_MS', '12000')),
    socketTimeout: Number(env('SMTP_SOCKET_TIMEOUT_MS', '15000')), 
    tls: {
      minVersion: 'TLSv1.2'
    }
  });
}

function withTimeout(promise, ms, label = 'SMTP request') {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export async function sendMail({ to, subject, html, text, timeoutMs = Number(env('SMTP_SEND_TIMEOUT_MS', '18000')) }) {
  if (!isSmtpConfigured() || !isEmailEnabled()) {
    console.log('\n--- EMAIL DEV MODE ---');
    console.log('SMTP status:', smtpStatus());
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log(text || html?.replace(/<[^>]+>/g, ''));
    console.log('--- END EMAIL DEV MODE ---\n');

    return {
      sent: false,
      devMode: true,
      message: 'SMTP not configured/enabled. Email printed in backend terminal.'
    };
  }

  const transporter = createMailTransporter();
  const info = await withTimeout(
    transporter.sendMail({
      from: env('MAIL_FROM') || `Takora Mart Task System <${env('SMTP_USER')}>`,
      to,
      subject,
      html,
      text
    }),
    timeoutMs,
    'SMTP sendMail'
  );

  return {
    sent: true,
    devMode: false,
    messageId: info.messageId
  };
}
