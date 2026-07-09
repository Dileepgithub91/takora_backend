import multer from 'multer';

const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 25);

const blockedExtensions = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.sh', '.php', '.js', '.jar'
]);

function hasBlockedExtension(filename = '') {
  const lower = filename.toLowerCase();
  return [...blockedExtensions].some(ext => lower.endsWith(ext));
}

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxUploadMb * 1024 * 1024,
    files: 10
  },
  fileFilter: (req, file, cb) => {
    if (hasBlockedExtension(file.originalname)) {
      cb(new Error('This file type is not allowed for security reasons'));
      return;
    }
    cb(null, true);
  }
});
