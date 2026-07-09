import { S3Client } from '@aws-sdk/client-s3';

function env(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

export function getS3Config() {
  return {
    region: env('AWS_REGION', 'ap-south-1'),
    bucket: env('AWS_S3_BUCKET'),
    accessKeyId: env('AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY')
  };
}

export function getS3Status() {
  const config = getS3Config();

  return {
    AWS_REGION: config.region || 'MISSING',
    AWS_S3_BUCKET: config.bucket || 'MISSING',
    AWS_ACCESS_KEY_ID: config.accessKeyId ? 'SET' : 'MISSING',
    AWS_SECRET_ACCESS_KEY: config.secretAccessKey ? 'SET' : 'MISSING'
  };
}

export function isS3Configured() {
  const config = getS3Config();

  return Boolean(
    config.region &&
    config.bucket &&
    config.accessKeyId &&
    config.secretAccessKey
  );
}

export function createS3Client() {
  const config = getS3Config();

  if (!isS3Configured()) {
    throw new Error(
      `AWS S3 is not configured. Current status: ${JSON.stringify(getS3Status())}`
    );
  }

  return new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}
