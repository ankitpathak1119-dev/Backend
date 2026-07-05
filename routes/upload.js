import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import UploadedFile from "../models/UploadedFile.js";

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
try {
  sharp = (await import("sharp")).default;
  console.log("✅ Sharp loaded — thumbnail generation enabled");
} catch (_) {
  console.warn("⚠️  Sharp not installed — thumbnails disabled. Run: npm install sharp");
}

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

  res.json({
    success: true,
    fileUrl: fileUrl,
    thumbnailUrl: thumbnailUrl,
    fileName: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });
});

export default router;
