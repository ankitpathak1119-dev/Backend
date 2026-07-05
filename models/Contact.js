import mongoose from "mongoose";

const contactSchema = new mongoose.Schema(
  {
    owner: { type: String, required: true },
    contact: { type: String, required: true },
  },
  { timestamps: true }
);

contactSchema.index({ owner: 1, contact: 1 }, { unique: true });

export default mongoose.model("Contact", contactSchema);
