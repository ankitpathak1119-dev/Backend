import express      from "express";
import User          from "../models/User.js";
import Group         from "../models/Group.js";
import PendingMessage from "../models/PendingMessage.js";
import ContactRequest from "../models/ContactRequest.js";
import Contact       from "../models/Contact.js";

const router = express.Router();

/**
 * DELETE /auth/delete-account
 * Permanently deletes user account and ALL related data.
 */
router.post("/delete-account", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username and password required" });
    }

    // 1. Find and verify user
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // ✅ Uses model method (bcrypt compare)
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Incorrect password" });
    }

    console.log(`🗑️  Deleting account: ${username}`);

    // 2. Handle all groups the user is a member of
    const userGroups = await Group.find({ members: username });
    const deletedGroupNames = [];

    for (const g of userGroups) {
      // Remove user from members
      g.members = g.members.filter((m) => m !== username);

      // Remove from owners array
      if (g.owners && g.owners.includes(username)) {
        g.owners = g.owners.filter((o) => o !== username);
      }

      if (g.members.length === 0) {
        // No members left — delete the group
        await Group.deleteOne({ _id: g._id });
        deletedGroupNames.push(g.name);
        console.log(`  → Deleted empty group: "${g.name}"`);

        // Notify all ex-members (none left, but was: [username])
        if (global.io) {
          global.io.to(username).emit("group_update", { type: "deleted", group: g.name });
        }
      } else {
        // Assign new primary owner if needed
        if (g.owner === username || !g.owners || g.owners.length === 0) {
          g.owner  = g.members[0];
          g.owners = [g.members[0]];
          console.log(`  → Transferred ownership of "${g.name}" to ${g.members[0]}`);
        }

        await g.save();
        console.log(`  → Removed "${username}" from group "${g.name}"`);

        // Notify remaining members
        if (global.io) {
          g.members.forEach((m) =>
            global.io.to(m).emit("group_update", {
              type:        "member_left",
              group:       g.name,
              leftMember:  username,
              members:     g.members,
              owners:      g.owners,
            })
          );
        }
      }
    }

    // 3. Delete pending messages (sent and received)
    const sentDel     = await PendingMessage.deleteMany({ from: username });
    const receivedDel = await PendingMessage.deleteMany({ to: username });
    console.log(`  → Deleted ${sentDel.deletedCount + receivedDel.deletedCount} pending messages`);

    // 4. Delete contact requests (sent and received)
    await ContactRequest.deleteMany({ $or: [{ from: username }, { to: username }] });
    console.log(`  → Deleted contact requests`);

    // 5. ✅ Remove from Contact collection (both directions)
    const contactsOfUser = await Contact.find({ owner: username });
    const removedContacts = contactsOfUser.map((c) => c.contact);

    await Contact.deleteMany({ $or: [{ owner: username }, { contact: username }] });
    console.log(`  → Removed ${removedContacts.length} contact entries`);

    // Notify users who had this user as contact
    if (global.io) {
      removedContacts.forEach((c) =>
        global.io.to(c).emit("contacts_updated", { removed: username })
      );
    }

    // 6. Delete the user account
    await User.deleteOne({ username });
    console.log(`✅ Account deleted: ${username}`);

    // 7. Disconnect their socket if online
    if (global.io) {
      const socketId = global.onlineUsers?.get(username);
      if (socketId) {
        global.io.sockets.sockets.get(socketId)?.disconnect(true);
      }
    }

    return res.json({
      success: true,
      message: "Account permanently deleted",
      deleted: {
        user:            username,
        groupsLeft:      userGroups.length,
        groupsDeleted:   deletedGroupNames.length,
        pendingMessages: sentDel.deletedCount + receivedDel.deletedCount,
        contacts:        removedContacts.length,
      },
    });

  } catch (error) {
    console.error("❌ Delete account error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete account",
      error:   error.message,
    });
  }
});

export default router;