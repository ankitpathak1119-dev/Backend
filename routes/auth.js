import express from "express";
import bcrypt  from "bcrypt";
import jwt     from "jsonwebtoken";
import User    from "../models/User.js";
import Group from "../models/Group.js";
import PendingMessage from "../models/PendingMessage.js";
import Contact from "../models/Contact.js";
import ContactRequest from "../models/ContactRequest.js";

const router     = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "securechat_jwt_secret_key";

// ── REGISTER ──────────────────────────────────────────────────────────────────
// Flutter sends: { username, password, recovery_phrase }
router.post("/register", async (req, res) => {
  try {
    const { username, password, recovery_phrase } = req.body;

    if (!username || !password || !recovery_phrase) {
      return res.status(400).json({ success: false, message: "All fields required" });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(409).json({ success: false, message: "Username already exists" });
    }

    // ✅ Model pre-save hook hashes password + recovery_phrase automatically
    const newUser = new User({ username, password, recovery_phrase });
    await newUser.save();

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });

    return res.status(201).json({
      success: true,
      message: "Registered successfully",
      token,
      username,
    });
  } catch (err) {
    console.error("❌ Register error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username & password required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      success: true,
      message: "Login successful",
      token,
      username: user.username,
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── VERIFY PASSWORD ───────────────────────────────────────────────────────────
router.post("/verify-password", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "All fields required" });
    }
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Wrong password" });

    return res.json({ success: true });
  } catch (err) {
    console.error("verify-password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── CHANGE PASSWORD ───────────────────────────────────────────────────────────
// Flutter sends: { username, old_password, new_password }
router.post("/change-password", async (req, res) => {
  try {
    const { username, old_password, new_password } = req.body;

    if (!username || !old_password || !new_password) {
      return res.status(400).json({ error: "All fields required" });
    }

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await user.comparePassword(old_password);
    if (!ok) return res.status(401).json({ error: "Wrong password" });

    // ✅ Assign plaintext — pre-save hook hashes it
    user.password = new_password;
    await user.save();

    return res.json({ success: true, message: "Password changed" });
  } catch (err) {
    console.error("change-password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── VERIFY RECOVERY PHRASE ────────────────────────────────────────────────────
// Flutter sends: { username, recovery_phrase }
router.post("/verify-recovery", async (req, res) => {
  try {
    const { username, recovery_phrase } = req.body;
    if (!username || !recovery_phrase) {
      return res.status(400).json({ error: "All fields required" });
    }
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await user.compareRecovery(recovery_phrase);
    if (!ok) return res.status(401).json({ error: "Wrong recovery phrase" });

    return res.json({ success: true });
  } catch (err) {
    console.error("verify-recovery error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── RESET PASSWORD (via recovery phrase) ─────────────────────────────────────
// Flutter sends: { username, recovery_phrase, new_password }
router.post("/reset-password", async (req, res) => {
  try {
    const { username, recovery_phrase, new_password } = req.body;

    if (!username || !recovery_phrase || !new_password) {
      return res.status(400).json({ error: "All fields required" });
    }

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await user.compareRecovery(recovery_phrase);
    if (!ok) return res.status(401).json({ error: "Invalid recovery phrase" });

    user.password = new_password; // pre-save hook hashes
    await user.save();

    return res.json({ success: true, message: "Password reset" });
  } catch (err) {
    console.error("reset-password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── UPDATE RECOVERY PHRASE ────────────────────────────────────────────────────
// Flutter sends: { username, password, new_recovery_phrase }
router.post("/update-recovery", async (req, res) => {
  try {
    const { username, password, new_recovery_phrase } = req.body;

    if (!username || !password || !new_recovery_phrase) {
      return res.status(400).json({ error: "All fields required" });
    }

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Wrong password" });

    user.recovery_phrase = new_recovery_phrase; // pre-save hook hashes
    await user.save();

    return res.json({ success: true, message: "Recovery phrase updated" });
  } catch (err) {
    console.error("update-recovery error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── CHECK USER EXISTS ─────────────────────────────────────────────────────────
router.post("/check-user", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ exists: false });
    const user = await User.findOne({ username });
    return res.json({ exists: !!user });
  } catch (err) {
    return res.status(500).json({ exists: false });
  }
});

// ── CHANGE USERNAME ───────────────────────────────────────────────────────────
// Flutter sends: { oldUsername, password, newUsername }
router.post("/change-username", async (req, res) => {
  const session = await User.startSession();
  try {
    const { oldUsername, password, newUsername } = req.body || {};

    const oldU = (oldUsername || "").trim();
    const newU = (newUsername || "").trim();

    if (!oldU || !newU || !password) {
      return res.status(400).json({ success: false, message: "oldUsername, newUsername and password required" });
    }
    if (oldU === newU) {
      return res.status(400).json({ success: false, message: "New username must be different" });
    }

    // Basic validation: 3-32 chars, letters/numbers/_ only
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(newU)) {
      return res.status(400).json({ success: false, message: "Username must be 3-32 characters (letters, numbers, underscore)" });
    }

    const existing = await User.findOne({ username: newU });
    if (existing) {
      return res.status(409).json({ success: false, message: "Username already exists" });
    }

    const user = await User.findOne({ username: oldU }).session(session);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(401).json({ success: false, message: "Incorrect password" });
    }

    await session.withTransaction(async () => {
      // 1) Update user document username
      user.username = newU;
      await user.save({ session });

      // 2) Update groups (members/owners arrays + primary owner field)
      await Group.updateMany(
        { members: oldU },
        [
          {
            $set: {
              members: {
                $map: {
                  input: "$members",
                  as: "m",
                  in: { $cond: [{ $eq: ["$$m", oldU] }, newU, "$$m"] },
                },
              },
              owners: {
                $map: {
                  input: "$owners",
                  as: "o",
                  in: { $cond: [{ $eq: ["$$o", oldU] }, newU, "$$o"] },
                },
              },
              owner: { $cond: [{ $eq: ["$owner", oldU] }, newU, "$owner"] },
            },
          },
        ],
        { session }
      );

      // 3) Update contacts & requests
      await Contact.updateMany({ owner: oldU }, { $set: { owner: newU } }, { session });
      await Contact.updateMany({ contact: oldU }, { $set: { contact: newU } }, { session });
      await ContactRequest.updateMany({ from: oldU }, { $set: { from: newU } }, { session });
      await ContactRequest.updateMany({ to: oldU }, { $set: { to: newU } }, { session });

      // 4) Update pending messages
      await PendingMessage.updateMany({ from: oldU }, { $set: { from: newU } }, { session });
      await PendingMessage.updateMany({ to: oldU }, { $set: { to: newU } }, { session });
    });

    // Disconnect old socket if online (forces re-join with new username)
    try {
      if (global.io && global.onlineUsers) {
        const oldSocketId = global.onlineUsers.get(oldU);
        if (oldSocketId) {
          global.io.sockets.sockets.get(oldSocketId)?.disconnect(true);
        }
      }
    } catch (_) {}

    const token = jwt.sign({ username: newU }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      success: true,
      message: "Username changed",
      username: newU,
      token,
    });
  } catch (err) {
    // Duplicate key conflicts (contacts index etc.)
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: "Username change caused duplicates. Please remove duplicate contacts and try again." });
    }
    console.error("❌ change-username error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  } finally {
    session.endSession();
  }
});

// ── UPLOAD PUBLIC KEY ─────────────────────────────────────────────────────────
router.post("/keys/upload", async (req, res) => {
  try {
    const { username, publicKey } = req.body;
    if (!username || !publicKey) {
      return res.status(400).json({ success: false, message: "Missing username or publicKey" });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== username) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    await User.updateOne({ username }, { $set: { publicKey } });
    return res.json({ success: true, message: "Public key uploaded" });
  } catch (err) {
    console.error("❌ Key upload error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET PUBLIC KEY ────────────────────────────────────────────────────────────
router.get("/keys/:username", async (req, res) => {
  try {
    const { username } = req.params;
    const user = await User.findOne({ username }, { publicKey: 1, _id: 0 });
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.json({ success: true, publicKey: user.publicKey });
  } catch (err) {
    console.error("❌ Get key error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;