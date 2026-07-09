import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  createS3Client,
  getS3Config,
  isS3Configured,
  getS3Status
} from '../config/s3.js';

function safeFileName(name = 'file') {
  const ext = path.extname(name);
  const base = path.basename(name, ext) || 'file';

  const cleanBase =
    base
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_]/g, '')
      .slice(0, 80) || 'file';

  const cleanExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '');

  return `${cleanBase}${cleanExt}`;
}

function safeMetadataValue(value = '') {
  return String(value).replace(/[^\x20-\x7E]/g, '').slice(0, 200);
}

export async function uploadBufferToS3(file, folder = 'documents') {
  if (!isS3Configured()) {
    throw new Error(
      `AWS S3 is not configured. Current status: ${JSON.stringify(getS3Status())}`
    );
  }

  if (!file?.buffer) {
    throw new Error('File is required');
  }

  const config = getS3Config();
  const s3Client = createS3Client();

  const originalName = file.originalname || 'file';
  const cleanedName = safeFileName(originalName);
  const key = `takora/${folder}/${Date.now()}-${uuidv4()}-${cleanedName}`;

  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype || 'application/octet-stream',
    Metadata: {
      originalName: safeMetadataValue(originalName)
    }
  });

  await s3Client.send(command);

  return {
    storage: 's3',
    key,
    filename: cleanedName,
    originalName,
    mimetype: file.mimetype || 'application/octet-stream',
    size: file.size || file.buffer.length
  };
}

export async function getSignedS3Url(
  key,
  expiresIn = Number(process.env.SIGNED_URL_EXPIRES_SECONDS || 3600)
) {
  if (!isS3Configured()) {
    throw new Error(
      `AWS S3 is not configured. Current status: ${JSON.stringify(getS3Status())}`
    );
  }

  if (!key) {
    throw new Error('S3 key is required');
  }

  const config = getS3Config();
  const s3Client = createS3Client();

  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ResponseContentDisposition: 'inline'
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

export async function deleteS3Object(key) {
  if (!key || !isS3Configured()) return;

  const config = getS3Config();
  const s3Client = createS3Client();

  const command = new DeleteObjectCommand({
    Bucket: config.bucket,
    Key: key
  });

  await s3Client.send(command);
}
