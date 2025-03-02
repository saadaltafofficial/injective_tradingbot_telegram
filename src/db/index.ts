import mongoose from "mongoose";
import { User } from "./models";
import dotenv from "dotenv";

dotenv.config();

// MongoDB connection string
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/injectivebot";

// Connect to MongoDB
export async function connectToDatabase() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");
    return true;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    return false;
  }
}

// Check if user exists, create if not
export async function getOrCreateUser(userId: string, username: string, firstName?: string, lastName?: string) {
  try {
    let user = await User.findOne({ userId });
    
    if (!user) {
      user = new User({
        userId,
        username,
        firstName,
        lastName,
        createdAt: new Date(),
        lastActive: new Date()
      });
      await user.save();
      console.log(`Created new user: ${username} (${userId})`);
    } else {
      // Update last active time
      user.lastActive = new Date();
      if (username && username !== user.username) {
        user.username = username;
      }
      if (firstName && firstName !== user.firstName) {
        user.firstName = firstName;
      }
      if (lastName && lastName !== user.lastName) {
        user.lastName = lastName;
      }
      await user.save();
    }
    
    return user;
  } catch (error) {
    console.error("Error in getOrCreateUser:", error);
    return null;
  }
}

// Check if database is connected
export function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

export const userModel = User;

