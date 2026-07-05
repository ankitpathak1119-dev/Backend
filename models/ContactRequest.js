import mongoose from "mongoose";

const requestSchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
  },
  { timestamps: true }
);

requestSchema.index({ from: 1, to: 1 }, { unique: true });

export default mongoose.model("ContactRequest", requestSchema);
