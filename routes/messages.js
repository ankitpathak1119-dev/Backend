import express from "express";
import User from "../models/User.js";
import PendingMessage from "../models/PendingMessage.js";

const router = express.Router();

// POST /messages/fcm-token — save on login, clear on logout (empty token)
router.post("/fcm-token", async (req, res) => {
  try {
    const { username, fcmToken } = req.body;
    if (!username)
      return res.status(400).json({ error: "username required" });

    // ✅ Empty token = logout → clear from DB so no stale notifications
    const tokenToSave = (fcmToken && fcmToken.trim()) ? fcmToken.trim() : null;
    await User.updateOne({ username }, { fcmToken: tokenToSave });
    return res.json({ message: tokenToSave ? "FCM token saved" : "FCM token cleared" });
  } catch (err) {
    console.error("fcm-token error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /messages/public-key — save RSA public key on register
router.post("/public-key", async (req, res) => {
  try {
    const { username, publicKey } = req.body;
    if (!username || !publicKey)
      return res.status(400).json({ error: "username and publicKey required" });

    await User.updateOne({ username }, { publicKey });
    return res.json({ message: "Public key saved" });
  } catch (err) {
    console.error("public-key error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /messages/public-key/:username — get recipient's public key before sending
router.get("/public-key/:username", async (req, res) => {
  try {
    const user = await User.findOne(
      { username: req.params.username },
      { publicKey: 1 }
    );
    if (!user || !user.publicKey)
      return res.status(404).json({ error: "Public key not found" });

    return res.json({ publicKey: user.publicKey });
  } catch (err) {
    console.error("get-public-key error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /messages/pending/:username — fetch all pending encrypted messages
router.get("/pending/:username", async (req, res) => {
  try {
    const messages = await PendingMessage.find({ to: req.params.username })
      .sort({ timestamp: 1 })
      .lean();
    return res.json({ messages });
  } catch (err) {
    console.error("fetch-pending error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// DELETE /messages/pending — delete after user reads (ephemeral)
router.delete("/pending", async (req, res) => {
  try {
    const { username, peer, messageIds } = req.body;

    if (messageIds?.length) {
      await PendingMessage.deleteMany({ messageId: { $in: messageIds } });
    } else if (username && peer) {
      await PendingMessage.deleteMany({
        $or: [
          { to: username, from: peer },
          { to: peer, from: username },
        ],
      });
    } else {
      return res.status(400).json({ error: "Provide username+peer or messageIds" });
    }

    return res.json({ message: "Deleted" });
  } catch (err) {
    console.error("delete-pending error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;