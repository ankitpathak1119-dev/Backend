import mongoose from "mongoose";

const GroupSchema = new mongoose.Schema(
  {
    name:    { type: String, required: true, unique: true, trim: true },
    owner:   { type: String, required: true, trim: true },  // primary owner (legacy compat)
    owners:  { type: [String], default: [] },               // all owners array
    members: { type: [String], default: [] },
  },
  { timestamps: true }
);

// ── Ensure owner is always in owners array ────────────────────────────────────
GroupSchema.pre("save", function (next) {
  if (!this.owners || this.owners.length === 0) {
    this.owners = [this.owner];
  }
  if (this.owner && !this.owners.includes(this.owner)) {
    this.owners.push(this.owner);
  }
  // Keep owner in sync with first owners entry when primary owner changes
  if (this.owners.length > 0 && !this.owners.includes(this.owner)) {
    this.owner = this.owners[0];
  }
  next();
});

export default mongoose.model("Group", GroupSchema);