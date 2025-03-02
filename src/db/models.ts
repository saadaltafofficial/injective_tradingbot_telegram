import { Schema, model, Document } from "mongoose";

// User model
export interface IUser extends Document {
  userId: string;
  username: string;
  firstName?: string;
  lastName?: string;
  defaultWallet?: string;
  createdAt: Date;
  lastActive: Date;
}

const UserSchema = new Schema<IUser>({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  firstName: { type: String },
  lastName: { type: String },
  defaultWallet: { type: String },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

export const User = model<IUser>("User", UserSchema);
