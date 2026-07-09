# Takora Mart Backend - S3 + SMTP Final

## Local Setup

```bash
cp .env.example .env
pnpm install --no-frozen-lockfile
pnpm run seed
pnpm run dev
```

Open: `http://localhost:5000`

## Required `.env`

```env
NODE_ENV=development
PORT=5000
MONGO_URI=your_mongodb_atlas_uri
JWT_SECRET=your_long_random_secret
JWT_EXPIRES_IN=7d
FRONTEND_URL=http://localhost:5173

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=it.takoramart@gmail.com
SMTP_PASS=your_google_app_password
MAIL_FROM="Takora Mart Task System <it.takoramart@gmail.com>"
ENABLE_EMAIL=true

AWS_REGION=ap-south-1
AWS_S3_BUCKET=takora-task-uploads
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
MAX_UPLOAD_MB=25
SIGNED_URL_EXPIRES_SECONDS=3600

ENABLE_WHATSAPP_MOCK=true
ENABLE_SMS_MOCK=true
ENABLE_AUTOMATION=true
```

## Render Environment Variables

Add the same values in Render Dashboard → Backend Service → Environment.
For live backend, set:

```env
NODE_ENV=production
FRONTEND_URL=https://takora-task-frontend.vercel.app
```

Then use:

```txt
Build Command: pnpm install --no-frozen-lockfile
Start Command: node src/server.js
```

## Important

- Gmail `SMTP_PASS` must be a Google App Password.
- Keep S3 bucket private. Block Public Access can stay ON.
- Files are opened using signed URLs.
- Do not push `.env` to GitHub.
# takora_backend
