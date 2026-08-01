import mongoose from "mongoose";

// Tracks uploaded files per chat — deleted when chat closes (ephemeral)
const uploadedFileSchema = new mongoose.Schema({
  filePath:  { type: String, required: true },           // "/uploads/123.jpg"
  thumbPath: { type: String, default: null },             // "/uploads/thumb_123.jpg" (images only)
  fileName:  { type: String, default: "file" },           // original file name
  mimetype:  { type: String, default: "application/octet-stream" },
  size:      { type: Number, default: 0 },
  from:      { type: String, required: true, index: true }, // who uploaded
  chatId:    { type: String, required: true, index: true }, // peer username or group name
  chatType:  { type: String, enum: ["private", "group", "profile"], default: "private" },
  createdAt: { type: Date, default: Date.now },
  // Safety: auto-delete after 24 hours even if chat_close missed
  expiresAt: {
    type:    Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    index:   { expires: 0 },
  },
});

export default mongoose.model("UploadedFile", uploadedFileSchema);
