import express from "express";
import Group   from "../models/Group.js";
import User    from "../models/User.js";

const router = express.Router();

const normalize = (v) => (typeof v === "string" ? v.trim() : "");
const uniq      = (arr) => [...new Set(arr.filter(Boolean).map((x) => x.trim()))];

// ── Helper: emit group_update to all members ──────────────────────────────────
function emitGroupUpdate(members, payload) {
  if (!global.io) return;
  members.forEach((m) => global.io.to(m).emit("group_update", payload));
}

// ── GET /groups/:user — list all groups for a user ────────────────────────────
router.get("/:user", async (req, res) => {
  try {
    const user = normalize(req.params.user);
    if (!user) return res.status(400).json({ error: "User required" });

    const groups = await Group.find({ members: user }).lean();
    return res.json({ groups });
  } catch (e) {
    console.error("Get groups error:", e);
    return res.status(500).json({ error: "Failed to fetch groups" });
  }
});

// ── POST /groups/create ───────────────────────────────────────────────────────
// Flutter sends: { group, owner, members[] }
router.post("/create", async (req, res) => {
  try {
    const groupName    = normalize(req.body.group);
    const owner        = normalize(req.body.owner);
    const inputMembers = Array.isArray(req.body.members) ? req.body.members : [];

    if (!groupName || !owner) {
      return res.status(400).json({ error: "group and owner are required" });
    }

    const exists = await Group.findOne({ name: groupName });
    if (exists) return res.status(409).json({ error: "Group already exists" });

    const members = uniq([owner, ...inputMembers.map((m) => normalize(m))]);

    const created = await Group.create({
      name:    groupName,
      owner,
      owners:  [owner],
      members,
    });

    console.log(`✅ Group created: "${groupName}" by ${owner}`);

    emitGroupUpdate(members, {
      type:    "created",
      group:   groupName,
      owner,
      members,
      owners:  [owner],
    });

    return res.status(201).json({
      success: true,
      message: "Group created",
      group:   created,
    });
  } catch (e) {
    console.error("Create group error:", e);
    return res.status(500).json({ error: "Create group failed" });
  }
});

// ── POST /groups/add-member ───────────────────────────────────────────────────
// Flutter sends: { group, owner, member }
router.post("/add-member", async (req, res) => {
  try {
    const groupName = normalize(req.body.group);      // ✅ Flutter key
    const owner     = normalize(req.body.owner);
    const member    = normalize(req.body.member);     // ✅ Flutter key

    if (!groupName || !owner || !member) {
      return res.status(400).json({ error: "group, owner, member required" });
    }

    const g = await Group.findOne({ name: groupName });
    if (!g) return res.status(404).json({ error: "Group not found" });

    // ✅ Check owners array
    if (!g.owners || !g.owners.includes(owner)) {
      return res.status(403).json({ error: "Only owners can add members" });
    }

    if (!g.members.includes(member)) {
      g.members = uniq([...g.members, member]);
      await g.save();
    }

    console.log(`✅ Added ${member} to group "${groupName}"`);

    emitGroupUpdate(g.members, {
      type:      "member_added",
      group:     groupName,
      newMember: member,
      members:   g.members,
    });
    // Also notify the newly added member
    if (global.io) {
      global.io.to(member).emit("group_update", {
        type:    "added_to_group",
        group:   groupName,
        members: g.members,
        owners:  g.owners,
      });
    }

    return res.json({ success: true, message: "Member added", members: g.members });
  } catch (e) {
    console.error("Add member error:", e);
    return res.status(500).json({ error: "Add member failed" });
  }
});

// ── POST /groups/remove-member ────────────────────────────────────────────────
// Flutter sends: { group, owner, member }
router.post("/remove-member", async (req, res) => {
  try {
    const groupName = normalize(req.body.group);
    const owner     = normalize(req.body.owner);
    const member    = normalize(req.body.member);

    if (!groupName || !owner || !member) {
      return res.status(400).json({ error: "group, owner, member required" });
    }

    const g = await Group.findOne({ name: groupName });
    if (!g) return res.status(404).json({ error: "Group not found" });

    if (!g.owners || !g.owners.includes(owner)) {
      return res.status(403).json({ error: "Only owners can remove members" });
    }
    if (g.owners.includes(member)) {
      return res.status(403).json({ error: "Cannot remove another owner. Remove ownership first." });
    }

    const beforeMembers = [...g.members];
    g.members = g.members.filter((m) => m !== member);
    await g.save();

    console.log(`✅ Removed ${member} from group "${groupName}"`);

    emitGroupUpdate([...new Set([...beforeMembers])], {
      type:          "member_removed",
      group:         groupName,
      removedMember: member,
      members:       g.members,
    });
    // Notify removed member separately
    if (global.io) {
      global.io.to(member).emit("group_update", { type: "removed_from_group", group: groupName });
    }

    return res.json({ success: true, message: "Member removed", members: g.members });
  } catch (e) {
    console.error("Remove member error:", e);
    return res.status(500).json({ error: "Remove member failed" });
  }
});

// ── POST /groups/leave ────────────────────────────────────────────────────────
// Flutter sends: { group, user }
router.post("/leave", async (req, res) => {
  try {
    const groupName = normalize(req.body.group);
    const user      = normalize(req.body.user);

    if (!groupName || !user) {
      return res.status(400).json({ error: "group and user required" });
    }

    const g = await Group.findOne({ name: groupName });
    if (!g) return res.status(404).json({ error: "Group not found" });

    const beforeMembers = [...g.members];
    g.members = g.members.filter((m) => m !== user);

    if (g.owners) {
      g.owners = g.owners.filter((o) => o !== user);
    }

    if (g.members.length === 0) {
      // No members left — delete group
      await Group.deleteOne({ name: groupName });
      console.log(`🗑️  Group auto-deleted (no members): "${groupName}"`);
      emitGroupUpdate(beforeMembers, { type: "deleted", group: groupName });
      return res.json({ success: true, message: "Left group (group deleted - no members)" });
    }

    // Reassign primary owner if needed
    if (!g.owners || g.owners.length === 0) {
      g.owners = [g.members[0]];
      g.owner  = g.members[0];
      console.log(`👑 Auto-promoted "${g.members[0]}" to owner of "${groupName}"`);
    } else if (g.owner === user) {
      g.owner = g.owners[0];
    }

    await g.save();
    console.log(`✅ ${user} left group "${groupName}"`);

    emitGroupUpdate([...new Set([...beforeMembers])], {
      type:       "member_left",
      group:      groupName,
      leftMember: user,
      members:    g.members,
      owners:     g.owners,
    });

    return res.json({ success: true, message: "Left group", members: g.members, owners: g.owners });
  } catch (e) {
    console.error("Leave group error:", e);
    return res.status(500).json({ error: "Leave group failed" });
  }
});

// ── POST /groups/delete ───────────────────────────────────────────────────────
// Flutter sends: { group, owner }
router.post("/delete", async (req, res) => {
  try {
    const groupName = normalize(req.body.group);    // ✅ Flutter key
    const owner     = normalize(req.body.owner);

    if (!groupName) {
      return res.status(400).json({ error: "group required" });
    }

    const g = await Group.findOne({ name: groupName });
    if (!g) return res.status(404).json({ error: "Group not found" });

    if (owner && g.owners && !g.owners.includes(owner)) {
      return res.status(403).json({ error: "Only owners can delete group" });
    }

    const allMembers = [...g.members];
    await Group.deleteOne({ name: groupName });

    console.log(`🗑️  Group deleted: "${groupName}" by ${owner}`);

    emitGroupUpdate(allMembers, {
      type:      "deleted",
      group:     groupName,
      deletedBy: owner,
    });

    return res.json({ success: true, message: "Group deleted", group: groupName });
  } catch (e) {
    console.error("Delete group error:", e);
    return res.status(500).json({ error: "Delete group failed" });
  }
});

// ── POST /groups/transfer-ownership ──────────────────────────────────────────
// Flutter may send:
//  - { group, owner, newOwner }
//  - { groupName, currentOwner, newOwner }
router.post("/transfer-ownership", async (req, res) => {
  try {
    const groupName    = normalize(req.body.group || req.body.groupName);
    const currentOwner = normalize(req.body.owner || req.body.currentOwner);
    const newOwner     = normalize(req.body.newOwner);

    if (!groupName || !currentOwner || !newOwner) {
      return res
        .status(400)
        .json({ error: "group/groupName, owner/currentOwner and newOwner required" });
    }

    const g = await Group.findOne({ name: groupName });
    if (!g) return res.status(404).json({ error: "Group not found" });

    if (!g.owners || !g.owners.includes(currentOwner)) {
      return res.status(403).json({ error: "Only owners can transfer ownership" });
    }
    if (!g.members.includes(newOwner)) {
      return res.status(400).json({ error: "New owner must be a group member" });
    }
    if (g.owners.includes(newOwner)) {
      return res.status(400).json({ error: "User is already an owner" });
    }

    g.owners.push(newOwner);
    await g.save();

    emitGroupUpdate(g.members, {
      type:     "ownership_transferred",
      group:    groupName,
      newOwner,
      owners:   g.owners,
    });

    return res.json({ success: true, message: "Ownership transferred", owners: g.owners });
  } catch (e) {
    console.error("Transfer ownership error:", e);
    return res.status(500).json({ error: "Failed to transfer ownership" });
  }
});

// ── POST /groups/remove-ownership ─────────────────────────────────────────────
// Flutter sends: { groupName, currentOwner, targetOwner }
// Backward compat: also accept { group, owner, targetOwner }
router.post("/remove-ownership", async (req, res) => {
  try {
    const groupName    = normalize(req.body.group || req.body.groupName);
    const currentOwner = normalize(req.body.owner || req.body.currentOwner);
    const targetOwner  = normalize(req.body.targetOwner);

    if (!groupName || !currentOwner || !targetOwner) {
      return res
        .status(400)
        .json({ error: "group/groupName, owner/currentOwner and targetOwner required" });
    }

    const g = await Group.findOne({ name: groupName });
    if (!g) return res.status(404).json({ error: "Group not found" });

    if (!g.owners || !g.owners.includes(currentOwner)) {
      return res.status(403).json({ error: "Only owners can remove ownership" });
    }
    if (!g.owners.includes(targetOwner)) {
      return res.status(400).json({ error: "Target user is not an owner" });
    }
    if (g.owners.length <= 1) {
      return res.status(400).json({ error: "At least one owner is required" });
    }

    const beforeOwners = [...g.owners];
    g.owners = g.owners.filter((o) => o !== targetOwner);

    // If primary owner was removed, reassign to first remaining owner
    if (g.owner === targetOwner) {
      g.owner = g.owners[0] || g.owner;
    }

    await g.save();

    emitGroupUpdate(g.members, {
      type:        "ownership_removed",
      group:       groupName,
      targetOwner,
      owners:      g.owners,
      beforeOwners,
    });

    return res.json({ success: true, message: "Ownership removed", owners: g.owners });
  } catch (e) {
    console.error("Remove ownership error:", e);
    return res.status(500).json({ error: "Failed to remove ownership" });
  }
});

// ── GET /keys/:groupName — fetch public keys for all members ─────────────────
router.get("/keys/:groupName", async (req, res) => {
  try {
    const groupName = normalize(req.params.groupName);
    const group = await Group.findOne({ name: groupName });
    if (!group) return res.status(404).json({ error: "Group not found" });

    const users = await User.find({ username: { $in: group.members } }, { username: 1, publicKey: 1, _id: 0 });
    const keys = {};
    users.forEach((u) => {
      if (u.publicKey) keys[u.username] = u.publicKey;
    });

    return res.json({ success: true, keys });
  } catch (e) {
    console.error("Get group keys error:", e);
    return res.status(500).json({ error: "Failed to fetch group keys" });
  }
});

export default router;