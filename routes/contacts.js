import express from "express";
import User from "../models/User.js";
import Contact from "../models/Contact.js";
import ContactRequest from "../models/ContactRequest.js";

const routerFactory = (io) => {
  const router = express.Router();

  router.post("/request", async (req, res) => {
    try {
      const { from, to } = req.body;
      if (!from || !to) return res.status(400).json({ error: "Missing fields" });
      if (from === to) return res.status(400).json({ error: "Invalid user" });

      const a = await User.findOne({ username: from });
      const b = await User.findOne({ username: to });
      if (!a || !b) return res.status(404).json({ error: "User not found" });

      const already = await Contact.findOne({ owner: from, contact: to });
      if (already) return res.status(409).json({ error: "Already contacts" });

      const pending = await ContactRequest.findOne({ from, to });
      if (pending) return res.status(409).json({ error: "Request already sent" });

      await ContactRequest.create({ from, to });
      return res.json({ message: "Request sent" });
    } catch {
      return res.status(500).json({ error: "Server error" });
    }
  });

  router.get("/requests/:user", async (req, res) => {
    const requests = await ContactRequest.find({ to: req.params.user }).lean();
    res.json({ requests });
  });

  router.post("/accept", async (req, res) => {
    const { from, to } = req.body;
    const reqDoc = await ContactRequest.findOne({ from, to });
    if (!reqDoc) return res.status(404).json({ error: "Request not found" });

    await Contact.updateOne({ owner: from, contact: to }, { $set: { owner: from, contact: to } }, { upsert: true });
    await Contact.updateOne({ owner: to, contact: from }, { $set: { owner: to, contact: from } }, { upsert: true });
    await ContactRequest.deleteOne({ from, to });

    io.to(from).emit("contacts_updated", { ok: true });
    io.to(to).emit("contacts_updated", { ok: true });

    res.json({ message: "Accepted" });
  });

  router.post("/decline", async (req, res) => {
    const { from, to } = req.body;
    await ContactRequest.deleteOne({ from, to });
    res.json({ message: "Declined" });
  });

  router.post("/remove", async (req, res) => {
    const { owner, contact } = req.body;
    await Contact.deleteOne({ owner, contact });
    await Contact.deleteOne({ owner: contact, contact: owner });
    io.to(owner).emit("contacts_updated", { ok: true });
    io.to(contact).emit("contacts_updated", { ok: true });
    res.json({ message: "Removed" });
  });

  router.get("/list/:user", async (req, res) => {
    const list = await Contact.find({ owner: req.params.user }).lean();
    res.json({ contacts: list.map((x) => x.contact) });
  });

  return router;
};

export default routerFactory;

