import express from 'express';
import Document from '../models/Document.js';
import { protect, readOnlyBlock } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { uploadBufferToS3, getSignedS3Url, deleteS3Object } from '../utils/s3Upload.js';

const router = express.Router();
router.use(protect);

async function addSignedUrls(doc) {
  const obj = doc.toObject ? doc.toObject() : { ...doc };

  if (obj.fileKey) {
    obj.downloadUrl = await getSignedS3Url(obj.fileKey);
    obj.needsReupload = false;
  } else {
    // Old Render/local files like /uploads/file.jpg are not permanent.
    // Do not return /uploads as a download URL because frontend hosting cannot route it.
    obj.downloadUrl = '';
    obj.needsReupload = true;
  }

  return obj;
}

router.get('/', async (req, res, next) => {
  try {
    const q = {};

    if (req.query.category) q.category = req.query.category;

    if (req.user.role === 'employee') {
      q.$or = [{ department: 'All' }, { department: req.user.department }];
    }

    const documents = await Document.find(q)
      .populate('uploadedBy', 'name email role')
      .sort({ createdAt: -1 });

    const result = await Promise.all(documents.map(addSignedUrls));
    res.json({ documents: result });
  } catch (error) {
    next(error);
  }
});

router.post('/', readOnlyBlock, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'File is required' });
    }

    const uploaded = await uploadBufferToS3(req.file, 'documents');

    const document = await Document.create({
      title: req.body.title || uploaded.originalName,
      category: req.body.category || 'Other',
      description: req.body.description || '',
      department: req.body.department || 'All',

      storage: 's3',
      fileKey: uploaded.key,
      fileName: uploaded.filename,
      filename: uploaded.filename,
      originalName: uploaded.originalName,
      mimetype: uploaded.mimetype,
      mimeType: uploaded.mimetype,
      size: uploaded.size,
      path: '',

      uploadedBy: req.user._id
    });

    res.status(201).json({
      message: 'Document uploaded permanently to AWS S3',
      document: await addSignedUrls(document)
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', readOnlyBlock, async (req, res, next) => {
  try {
    if (!['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    const document = await Document.findById(req.params.id);

    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }

    if (document.fileKey) {
      await deleteS3Object(document.fileKey);
    }

    await document.deleteOne();
    res.json({ message: 'Document deleted' });
  } catch (error) {
    next(error);
  }
});

export default router;
