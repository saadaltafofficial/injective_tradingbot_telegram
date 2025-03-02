import { Schema, model, Document } from "mongoose";

export interface IUserSettings extends Document {
  userId: string;
  userName: string;
  wallets: {
    name: string;
    address: string;
    encrypted: string;
    iv: string;
    tag: string;
  }[];
  tradingPreferences: {
    defaultWallet: string;
    slippageTolerance: number;
    maxTransactionAmount: number;
    autoConfirm: boolean;
  };
  notificationPreferences: {
    priceAlerts: boolean;
    tradingUpdates: boolean;
    channel: 'telegram' | 'email' | 'both';
    frequency: 'realtime' | 'daily' | 'weekly';
  };
  language: string;
  securitySettings: {
    twoFactorEnabled: boolean;
    lastSecurityCheck: Date;
  };
}

const UserSettingsSchema = new Schema<IUserSettings>({
  userId: { type: String, required: true, unique: true },
  userName: { type: String, required: true },
  wallets: [{
    name: { type: String, required: true },
    address: { type: String, required: true },
    encrypted: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true }
  }],
  tradingPreferences: {
    defaultWallet: { type: String, default: "" },
    slippageTolerance: { type: Number, default: 0.5 },
    maxTransactionAmount: { type: Number, default: 1000 },
    autoConfirm: { type: Boolean, default: false }
  },
  notificationPreferences: {
    priceAlerts: { type: Boolean, default: false },
    tradingUpdates: { type: Boolean, default: false },
    channel: { type: String, default: 'telegram', enum: ['telegram', 'email', 'both'] },
    frequency: { type: String, default: 'daily', enum: ['realtime', 'daily', 'weekly'] }
  },
  language: { type: String, default: 'English' },
  securitySettings: {
    twoFactorEnabled: { type: Boolean, default: false },
    lastSecurityCheck: { type: Date, default: Date.now }
  }
});

export const UserSettings = model<IUserSettings>("UserSettings", UserSettingsSchema);
