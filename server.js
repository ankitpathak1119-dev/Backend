import express       from "express";
import cors          from "cors";
import http          from "http";
import { Server }   from "socket.io";
import mongoose      from "mongoose";
import jwt           from "jsonwebtoken";
import { createRequire } from "module";
import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging }        from "firebase-admin/messaging";

import authRoutes          from "./routes/auth.js";
import deleteAccountRoutes from "./routes/delete_account.js";
import contactsRoutes      from "./routes/contacts.js";
import groupsRoutes        from "./routes/groups.js";
import messagesRoutes      from "./routes/messages.js";
import uploadRoutes        from "./routes/upload.js";
import Group               from "./models/Group.js";
import path                from "path";
import fs                  from "fs";
import User                from "./models/User.js";
import PendingMessage      from "./models/PendingMessage.js";
import UploadedFile        from "./models/UploadedFile.js";

// ── Firebase Admin ────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
let serviceAccount = null;
let fcmMessaging = null;

try {
  // Try loading from local file
  serviceAccount = require("./firebase-service-account.json");
} catch (e) {
  // Fallback to Environment Variable on Render/Cloud
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (parseErr) {
      console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT env var:", parseErr.message);
    }
  } else {
    console.warn("⚠️ Firebase service account missing. FCM notifications will be disabled.");
  }
  if (serviceAccount && typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
}

if (serviceAccount) {
  try {
    initializeApp({ credential: cert(serviceAccount) });
    fcmMessaging = getMessaging();
    console.log("✅ Firebase initialized:", serviceAccount.project_id);
  } catch (err) {
    console.error("❌ Firebase init FAILED:", err.message);
  }
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

global.io = io;

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "securechat_jwt_secret_key";
const MONGO_URI  = process.env.MONGO_URI  ||
  "mongodb+srv://securechat_user:An%401728396497@cluster0.bm68qog.mongodb.net/secure_chat";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ── HTTP Routes ───────────────────────────────────────────────────────────────
app.use("/auth",     authRoutes);
app.use("/auth",     deleteAccountRoutes);
app.use("/contacts", contactsRoutes(io));
app.use("/groups",   groupsRoutes);
app.use("/messages", messagesRoutes);
app.use("/upload",   uploadRoutes);
app.use("/uploads",  express.static(path.join(process.cwd(), "uploads"), {
  maxAge: "1h",  // short-term cache — files are ephemeral
  etag: true,
}));

app.get("/", (_, res) => res.json({ status: "ok" }));
app.get("/health", (_, res) => res.json({
  status:      "ok",
  mongo:       mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  onlineUsers: onlineUsers.size,
  firebase:    fcmMessaging ? "ok" : "FAILED",
}));

// ── Debug: FCM token check ────────────────────────────────────────────────────
app.get("/debug/fcm/:username", async (req, res) => {
  const user = await User.findOne({ username: req.params.username }, { fcmToken: 1 });
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({ hasToken: !!user.fcmToken, preview: user.fcmToken?.slice(0, 20) });
});

// ═════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═════════════════════════════════════════════════════════════════════════════
const onlineUsers          = new Map(); // username → socketId
const activeChats          = new Map(); // username → chatId   (private OR group name)
const joinedGroupsBySocket = new Map(); // socketId → Set<groupName>
const groupSeen            = new Map(); // messageId → { totalMembers, seenCount, ... }

global.onlineUsers = onlineUsers;

const mask = (u) => (!u || u.length < 3) ? "***" : `${u[0]}***${u[u.length-1]}`;

function verifyToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET)?.username || null; }
  catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// FCM SEND
// Private  → title: "New message from Ali",   data: { type:"private", chatId:"Ali" }
// Group    → title: "New message in College",  data: { type:"group",   chatId:"College" }
// ─────────────────────────────────────────────────────────────────────────────
async function sendPush({ fcmToken, fromUser, chatId, chatType }) {
  if (!fcmToken) {
    console.warn(`⚠️  FCM skip — no token (from: ${mask(fromUser)}, chat: ${chatId})`);
    return;
  }
  if (!fcmMessaging) {
    console.error("❌ FCM not initialized");
    return;
  }

  const isGroup = chatType === "group";
  const title   = isGroup
    ? `New message in ${chatId}`          // chatId = group name
    : `New message from ${fromUser}`;     // chatId = sender username

  try {
    const result = await fcmMessaging.send({
      token: fcmToken,
      notification: { title, body: "Tap to open" },
      data: {
        type:     chatType,   // "private" | "group"
        chatId:   chatId,     // group name OR sender username
        fromUser: fromUser,
      },
      android: {
        priority: "high",
        notification: {
          channelId:             "secure_chat_messages",
          sound:                 "default",
          priority:              "high",
          defaultSound:          true,
          defaultVibrateTimings: true,
        },
      },
    });
    console.log(`✅ FCM sent [${chatType}] → ${mask(fromUser)} msgId: ${result}`);
  } catch (err) {
    console.error(`❌ FCM error [${chatType}] from ${mask(fromUser)}:`, err.code, err.message);
    // Clear invalid/expired token so we don't retry
    if (["messaging/invalid-registration-token",
         "messaging/registration-token-not-registered",
         "messaging/invalid-argument"].includes(err.code)) {
      await User.updateOne({ fcmToken }, { $set: { fcmToken: null } }).catch(() => {});
      console.log("🗑️  Cleared invalid FCM token");
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═════════════════════════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);

  // ── JOIN ──────────────────────────────────────────────────────────────────
  socket.on("join", async ({ username }) => {
    try {
      if (!username?.trim()) return socket.disconnect();
      username = username.trim();

      const tokenUser = verifyToken(socket.handshake.auth?.token);
      if (tokenUser) {
        if (tokenUser !== username) return socket.disconnect();
      } else {
        const user = await User.findOne({ username });
        if (!user) return socket.disconnect();
      }

      if (socket.username === username) return;

      if (socket.username) {
        socket.leave(socket.username);
        onlineUsers.delete(socket.username);
        activeChats.delete(socket.username);
      }

      const existingId = onlineUsers.get(username);
      if (existingId && existingId !== socket.id) {
        io.sockets.sockets.get(existingId)?.disconnect();
      }

      socket.join(username);
      socket.username = username;
      onlineUsers.set(username, socket.id);

      io.emit("presence:update", { userId: username, status: "online" });
      socket.emit("presence:snapshot", { onlineUsers: [...onlineUsers.keys()] });

      // ── Deliver ALL pending messages (private + group) on login ───────────
      const pending = await PendingMessage.find({ to: username }).sort({ timestamp: 1 });
      for (const msg of pending) {
        if (msg.chatType === "group") {
          // ✅ Group pending → emit as group_message so Flutter shows it in group chat
          socket.emit("group_message", {
            group:            msg.groupName,
            from:             msg.from,
            encryptedMessage: msg.encryptedMessage,
            messageId:        msg.messageId,
            timestamp:        msg.timestamp,
            isPending:        true,
          });
        } else {
          socket.emit("private_message", {
            from:             msg.from,
            encryptedMessage: msg.encryptedMessage,
            messageId:        msg.messageId,
            timestamp:        msg.timestamp,
            isPending:        true,
          });
        }
      }
      if (pending.length > 0)
        console.log(`📬 Delivered ${pending.length} pending → ${mask(username)}`);

    } catch (err) {
      console.error("❌ join error:", err.message);
      socket.disconnect();
    }
  });

  // ── CHAT OPEN ─────────────────────────────────────────────────────────────
  // Called when user taps a private chat OR group chat screen opens
  // chatId = sender username (private) OR group name (group)
  socket.on("chat_open", ({ chatId }) => {
    if (!socket.username || !chatId) return;
    activeChats.set(socket.username, chatId);
    _markGroupMessagesSeen(socket.username, chatId);

    // ✅ Do NOT delete here — wait for messages_read confirmation from Flutter
    for (const [other, otherChat] of activeChats.entries()) {
      if (other !== socket.username && otherChat === chatId && onlineUsers.has(other)) {
        io.to(socket.username).emit("presence:active", { userId: other });
        io.to(other).emit("presence:active",           { userId: socket.username });
      }
    }
  });

  // ── MESSAGES READ ─────────────────────────────────────────────────────────
  // Flutter may emit this after rendering on screen.
  // Current UX requirement: delete pending on chat_close (after user exits),
  // not immediately when messages appear.
  socket.on("messages_read", ({ chatId }) => {
    if (!socket.username || !chatId) return;
    // no-op (kept for backward compatibility / future analytics)
  });

  // ── CHAT CLOSE ────────────────────────────────────────────────────────────
  // Flutter emits when user navigates away from chat screen
  // chatId = sender username (private) OR group name (group)
  socket.on("chat_close", ({ chatId } = {}) => {
    if (!socket.username) return;
    const chat = chatId || activeChats.get(socket.username);
    activeChats.delete(socket.username);
    if (chat) {
      // ✅ Delete only THIS user's pending for this chat AFTER close.
      PendingMessage.deleteMany({
        to: socket.username,
        $or: [{ from: chat }, { groupName: chat }],
      })
        .then((result) => {
          if (result?.deletedCount > 0) {
            console.log(
              `🗑️  chat_close: deleted ${result.deletedCount} pending for ${mask(socket.username)} in ${chat}`
            );
          }
        })
        .catch((err) => {
          console.error("⚠️  chat_close delete error:", err.message);
        });

      // ✅ Delete uploaded files for this chat (ephemeral — WhatsApp style)
      _deleteFilesForChat(socket.username, chat);
    }
  });

  // ── PRIVATE MESSAGE ───────────────────────────────────────────────────────
  socket.on("private_message", async ({ to, from, message, encryptedMessage, messageId, chatId }) => {
    if (!to) return;
    const sender       = socket.username || from;
    const hasEncrypted = encryptedMessage != null && encryptedMessage !== "";
    const hasPlain     = message != null && message !== "";
    if (!hasEncrypted && !hasPlain) return;

    const msgId   = messageId || `${Date.now()}_${sender}`;
    const payload = { from: sender, message, encryptedMessage, messageId: msgId, timestamp: new Date().toISOString() };

    console.log(`📨 Private: ${mask(sender)} → ${mask(to)}`);

    if (onlineUsers.has(to)) {
      // Online → deliver directly
      io.to(to).emit("private_message", payload);
      io.to(sender).emit("chat:delivered", { messageId: msgId });
      if (activeChats.get(to) === (chatId || sender))
        io.to(sender).emit("chat:seen", { messageId: msgId });
    } else {
      // Offline → store + FCM
      if (hasEncrypted) {
        try {
          await PendingMessage.findOneAndUpdate(
            { messageId: msgId },
            { to, from: sender, encryptedMessage, messageId: msgId, chatType: "private" },
            { upsert: true, new: true }
          );
          const recipient = await User.findOne({ username: to }, { fcmToken: 1 });
          await sendPush({
            fcmToken: recipient?.fcmToken,
            fromUser: sender,
            chatId:   sender,        // ✅ private: chatId = sender so Flutter opens private chat
            chatType: "private",
          });
          console.log(`💾 Stored private pending for ${mask(to)}`);
        } catch (err) {
          console.error("⚠️  Private store error:", err.message);
        }
      }
    }
  });

  // ── GROUP MESSAGE ─────────────────────────────────────────────────────────
  socket.on("group_message", async ({ group, from, message, encryptedMessage, messageId }) => {
    if (!group) return;
    const sender       = socket.username || from;
    const hasEncrypted = encryptedMessage != null && encryptedMessage !== "";
    const hasPlain     = message != null && message !== "";
    if (!hasEncrypted && !hasPlain) return;

    const msgId   = messageId || `${Date.now()}_${Math.random()}`;
    const content = encryptedMessage || message;

    // ✅ Deliver to ALL online group members via socket room
    io.to(group).emit("group_message", {
      group,
      from:             sender,
      message:          hasPlain     ? message          : undefined,
      encryptedMessage: hasEncrypted ? encryptedMessage : undefined,
      messageId:        msgId,
      timestamp:        new Date().toISOString(),
    });

    console.log(`📨 Group: ${mask(sender)} → ${group}`);

    try {
      const groupDoc = await Group.findOne({ name: group }).lean();
      if (!groupDoc) return;

      groupSeen.set(msgId, {
        totalMembers: groupDoc.members.length,
        seenCount:    1,
        senderId:     sender,
        groupId:      group,
        createdAt:    Date.now(),
      });

      // ✅ Only offline members → store pending + send FCM
      const offlineMembers = groupDoc.members.filter(
        (m) => m !== sender && !onlineUsers.has(m)
      );

      console.log(`📲 Group offline members: ${offlineMembers.length}/${groupDoc.members.length}`);

      for (const member of offlineMembers) {
        // Store pending per member with groupName field
        if (hasEncrypted) {
          await PendingMessage.findOneAndUpdate(
            { messageId: msgId, to: member },
            {
              to:               member,
              from:             sender,
              encryptedMessage: encryptedMessage,
              messageId:        `${msgId}_${member}`,  // unique per member
              chatType:         "group",
              groupName:        group,
            },
            { upsert: true, new: true }
          ).catch((e) => console.error("⚠️  Group pending store error:", e.message));
        }

        // Send FCM
        const u = await User.findOne({ username: member }, { fcmToken: 1 });
        if (u?.fcmToken) {
          await sendPush({
            fcmToken: u.fcmToken,
            fromUser: sender,
            chatId:   group,        // ✅ group: chatId = group name so Flutter opens group chat
            chatType: "group",
          });
        }
      }
    } catch (err) {
      console.error("⚠️  Group message error:", err.message);
    }
  });

  // ── TYPING ────────────────────────────────────────────────────────────────
  socket.on("typing", ({ from, to, isTyping }) => {
    if (!to) return;
    socket.to(to).emit("typing", { from: socket.username || from, isTyping: !!isTyping });
  });

  // ── GROUP TYPING ──────────────────────────────────────────────────────────
  socket.on("group_typing", ({ group, from, isTyping }) => {
    if (!group) return;
    socket.to(group).emit("group_typing", {
      group, from: socket.username || from, isTyping: !!isTyping,
    });
  });

  // ── GROUP JOIN / LEAVE ────────────────────────────────────────────────────
  socket.on("join_group", ({ group }) => {
    if (!group?.trim()) return;
    const g = group.trim();
    let set = joinedGroupsBySocket.get(socket.id);
    if (!set) { set = new Set(); joinedGroupsBySocket.set(socket.id, set); }
    if (set.has(g)) return;
    socket.join(g);
    set.add(g);
  });

  socket.on("leave_group", ({ group }) => {
    if (!group?.trim()) return;
    socket.leave(group.trim());
    joinedGroupsBySocket.get(socket.id)?.delete(group.trim());
  });

  // ── GROUP SEEN ACK ────────────────────────────────────────────────────────
  socket.on("group_message_seen", ({ messageId }) => {
    if (messageId && socket.username) _incrementGroupSeen(socket.username, messageId);
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    if (socket.username && onlineUsers.get(socket.username) === socket.id) {
      // ✅ Clean up uploaded files if user had an active chat
      const activeChat = activeChats.get(socket.username);
      if (activeChat) {
        _deleteFilesForChat(socket.username, activeChat);
      }

      onlineUsers.delete(socket.username);
      activeChats.delete(socket.username);
      _handleMemberDisconnect(socket.username);
      io.emit("presence:update", { userId: socket.username, status: "offline" });
    }
    joinedGroupsBySocket.delete(socket.id);
    console.log("🔌 Disconnected:", socket.id);
  });
});

// ── Group Seen Helpers ────────────────────────────────────────────────────────
function _markGroupMessagesSeen(username, chatId) {
  for (const [mid, data] of groupSeen.entries()) {
    if (data.groupId === chatId) _incrementGroupSeen(username, mid);
  }
}
function _incrementGroupSeen(username, messageId) {
  const data = groupSeen.get(messageId);
  if (!data) return;
  data.seenCount++;
  if (data.seenCount >= data.totalMembers) {
    io.to(data.senderId).emit("chat:seen", { messageId });
    groupSeen.delete(messageId);
  }
}
function _handleMemberDisconnect(username) {
  for (const [mid, data] of groupSeen.entries()) {
    data.totalMembers = Math.max(data.seenCount + 1, data.totalMembers - 1);
    if (data.seenCount >= data.totalMembers) {
      io.to(data.senderId).emit("chat:seen", { messageId: mid });
      groupSeen.delete(mid);
    }
  }
}
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [id, d] of groupSeen.entries())
    if (d.createdAt < cutoff) groupSeen.delete(id);
}, 600_000);

// ── File Cleanup Helper ──────────────────────────────────────────────────────
async function _deleteFilesForChat(username, chatId) {
  try {
    // Find files sent TO this user in this chat, OR sent BY this user
    const files = await UploadedFile.find({
      $or: [
        { chatId: chatId, from: { $ne: username } },  // files sent TO this user
        { chatId: username, from: chatId },            // files sent BY peer to this user
      ],
    });

    if (files.length === 0) return;

    const uploadsDir = path.join(process.cwd(), "");
    for (const file of files) {
      // Delete original file from disk
      if (file.filePath) {
        const fullPath = path.join(uploadsDir, file.filePath);
        fs.unlink(fullPath, (err) => {
          if (err && err.code !== "ENOENT") console.error("⚠️  File delete error:", err.message);
        });
      }
      // Delete thumbnail from disk
      if (file.thumbPath) {
        const thumbFullPath = path.join(uploadsDir, file.thumbPath);
        fs.unlink(thumbFullPath, (err) => {
          if (err && err.code !== "ENOENT") console.error("⚠️  Thumb delete error:", err.message);
        });
      }
    }

    // Delete tracking records from DB
    const result = await UploadedFile.deleteMany({
      _id: { $in: files.map((f) => f._id) },
    });

    if (result.deletedCount > 0) {
      console.log(
        `🗑️  Deleted ${result.deletedCount} files for ${mask(username)} in chat ${chatId}`
      );
    }
  } catch (err) {
    console.error("⚠️  File cleanup error:", err.message);
  }
}

// ── Cleanup Cron: Delete orphan files older than 24h ─────────────────────────
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const oldFiles = await UploadedFile.find({ createdAt: { $lt: cutoff } });

    if (oldFiles.length === 0) return;

    const uploadsDir = path.join(process.cwd(), "");
    for (const file of oldFiles) {
      if (file.filePath) {
        const fullPath = path.join(uploadsDir, file.filePath);
        fs.unlink(fullPath, () => {});
      }
      if (file.thumbPath) {
        const thumbFullPath = path.join(uploadsDir, file.thumbPath);
        fs.unlink(thumbFullPath, () => {});
      }
    }

    const result = await UploadedFile.deleteMany({ createdAt: { $lt: cutoff } });
    if (result.deletedCount > 0) {
      console.log(`🧹 Cleanup cron: deleted ${result.deletedCount} orphan files`);
    }
  } catch (err) {
    console.error("⚠️  Cleanup cron error:", err.message);
  }
}, 60 * 60 * 1000); // Run every hour

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
