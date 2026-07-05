import mongoose from "mongoose";
import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

const userSchema = new mongoose.Schema({
  username:        { type: String, unique: true, required: true, trim: true },
  password:        { type: String, required: true },
  recovery_phrase: { type: String, required: true },   // ✅ consistent field name
  fcmToken:        { type: String, default: null },
  publicKey:       { type: String, default: null },
});

// ── Auto-hash password before save ───────────────────────────────────────────
userSchema.pre("save", async function (next) {
  // Only hash if password was modified (not already hashed)
  if (!this.isModified("password")) return next();
  try {
    this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
    next();
  } catch (err) {
    next(err);
  }
});

// ── Auto-hash recovery_phrase before save ────────────────────────────────────
userSchema.pre("save", async function (next) {
  if (!this.isModified("recovery_phrase")) return next();
  try {
    this.recovery_phrase = await bcrypt.hash(this.recovery_phrase, SALT_ROUNDS);
    next();
  } catch (err) {
    next(err);
  }
});

// ── comparePassword method ────────────────────────────────────────────────────
userSchema.methods.comparePassword = async function (plainPassword) {
  return bcrypt.compare(plainPassword, this.password);
};

// ── compareRecovery method ────────────────────────────────────────────────────
userSchema.methods.compareRecovery = async function (plainPhrase) {
  return bcrypt.compare(plainPhrase, this.recovery_phrase);
};

export default mongoose.model("User", userSchema);