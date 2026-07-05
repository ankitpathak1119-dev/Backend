import mongoose from "mongoose";

// Stores encrypted messages for offline users
// Auto-deletes after 7 days via MongoDB TTL
// Server NEVER stores plaintext — only encrypted blobs
const pendingMessageSchema = new mongoose.Schema({
  to:               { type: String, required: true, index: true },
  from:             { type: String, required: true },
  encryptedMessage: { type: String, required: true }, // encrypted blob only
  messageId:        { type: String, required: true, unique: true },
  chatType:         { type: String, enum: ["private", "group"], default: "private" },
  groupName:        { type: String, default: null },
  timestamp:        { type: Date, default: Date.now },
  expiresAt: {
    type:    Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    index:   { expires: 0 }, // MongoDB TTL — auto delete
  },
});

export default mongoose.model("PendingMessage", pendingMessageSchema);