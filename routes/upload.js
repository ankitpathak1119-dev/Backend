import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { EventEmitter } from "events";
import UploadedFile from "../models/UploadedFile.js";

export const uploadEvents = new EventEmitter();
const router = express.Router();

// Ensure uploads directory exists
const uploadDir = path.join(process.cwd(), "uploads");
const thumbDir = path.join(uploadDir, "thumbs");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(thumbDir)) {
  fs.mkdirSync(thumbDir, { recursive: true });
}

// Dynamic import for sharp (may not be installed on all systems)
let sharp = null;
// Sharp disabled to prevent out of memory crashes on Render Free Tier
console.warn("⚠️  Sharp disabled to prevent OOM on free tier.");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

// No file size limit
const upload = multer({ storage: storage });

router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  const isImage = req.file.mimetype.startsWith("image/");
  let thumbnailUrl = null;

  // Generate thumbnail for images only (original stays HD untouched)
  if (isImage && sharp) {
    try {
      const thumbName = `thumb_${req.file.filename}`;
      const thumbPath = path.join(thumbDir, thumbName);
      await sharp(req.file.path)
        .resize(300, 300, { fit: "cover", withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toFile(thumbPath);
      thumbnailUrl = `/uploads/thumbs/${thumbName}`;
    } catch (err) {
      console.error("⚠️  Thumbnail generation failed:", err.message);
      // Continue without thumbnail — original image will be used
    }
  }

  // Track file for ephemeral deletion
  const from = req.body.from || "unknown";
  const chatId = req.body.chatId || "unknown";
  const chatType = req.body.chatType || "private";

  try {
    await UploadedFile.create({
      filePath: fileUrl,
      thumbPath: thumbnailUrl,
      fileName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      from: from,
      chatId: chatId,
      chatType: chatType,
    });
  } catch (err) {
    console.error("⚠️  File tracking save error:", err.message);
    // Don't fail the upload — file is already saved
  }

  // Dispatch message event if this upload is a message
  if (req.body.isMessage === 'true') {
    const duration = parseInt(req.body.duration) || 0;
    const fileMessage = {
      type: req.file.mimetype,
      url: fileUrl,
      fileName: req.file.originalname,
      size: req.file.size,
      duration: duration
    };
    if (thumbnailUrl) fileMessage.thumbnailUrl = thumbnailUrl;
    if (req.body.isViewOnce === 'true') {
      fileMessage.isViewOnce = true;
      fileMessage.viewOnceTimer = parseInt(req.body.viewOnceTimer) || 0;
    }
    
    const msgString = `FILE::${JSON.stringify(fileMessage)}`;
    uploadEvents.emit('fileMessageUploaded', {
      from,
      chatId,
      chatType,
      message: msgString,
      messageId: req.body.messageId // Optional, can let server generate
    });
  }

  res.json({
    success: true,
    fileUrl: fileUrl,
    thumbnailUrl: thumbnailUrl,
    fileName: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });
});

router.delete("/", async (req, res) => {
  const { fileUrl } = req.body;
  if (!fileUrl) {
    return res.status(400).json({ error: "No fileUrl provided" });
  }

  try {
    const fileRecord = await UploadedFile.findOne({ filePath: fileUrl });
    if (!fileRecord) {
      return res.status(404).json({ error: "File not found" });
    }

    const uploadsDir = process.cwd();
    
    if (fileRecord.filePath) {
      const fullPath = path.join(uploadsDir, fileRecord.filePath);
      fs.unlink(fullPath, () => {});
    }
    
    if (fileRecord.thumbPath) {
      const thumbFullPath = path.join(uploadsDir, fileRecord.thumbPath);
      fs.unlink(thumbFullPath, () => {});
    }

    await UploadedFile.deleteOne({ _id: fileRecord._id });
    
    console.log(`🗑️  Deleted view-once file: ${fileUrl}`);
    res.json({ success: true, message: "File deleted successfully" });
  } catch (err) {
    console.error("⚠️  Delete file error:", err.message);
    res.status(500).json({ error: "Server error during deletion" });
  }
});

export default router;
