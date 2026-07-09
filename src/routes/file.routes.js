import express from 'express';
import { protect } from '../middleware/auth.js';
import { getSignedS3Url } from '../utils/s3Upload.js';

const router = express.Router();
router.use(protect);

router.get('/signed-url', async (req, res, next) => {
  try {
    const key = String(req.query.key || '').trim();

    if (!key) {
      return res.status(400).json({ message: 'File key is required' });
    }

    const url = await getSignedS3Url(key);
    res.json({ url });
  } catch (error) {
    next(error);
  }
});

export default router;
