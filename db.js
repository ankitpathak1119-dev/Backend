import mongoose from "mongoose";

const connectDB = async () => {
  try {
    await mongoose.connect(
      "mongodb+srv://securechat_user:An%401728396497@cluster0.bm68qog.mongodb.net/secure_chat?appName=Cluster0"
    );
    console.log("✅ MongoDB connected");
  } catch (error) {
    console.error("❌ MongoDB error:", error);
    process.exit(1);
  }
};

export default connectDB;
