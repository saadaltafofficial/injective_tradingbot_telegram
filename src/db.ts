import mongoose from "mongoose";
const { Schema } = mongoose;

// Interface for User document
interface IUser extends mongoose.Document {
  userName: string;  // Telegram username
  telegramId: string;  // Telegram user ID
  firstName?: string;  // Telegram first name
  lastName?: string;  // Telegram last name
  createdAt: Date;
  updatedAt: Date;
}

// Create schemas
const userSchema = new Schema<IUser>({
  userName: { 
    type: String, 
    required: true, 
    unique: true,
  },
  telegramId: {
    type: String,
    required: true,
    unique: true,
  },
  firstName: {
    type: String,
  },
  lastName: {
    type: String,
  },
}, {
  timestamps: true,  // Automatically add createdAt and updatedAt fields
});

// Create indexes after ensuring collections are clean
console.log('Creating indexes...');
userSchema.index({ userName: 1 }, { unique: true });
userSchema.index({ telegramId: 1 }, { unique: true });

// Create models
export const userModel = mongoose.model<IUser>('User', userSchema);

// Initialize database
async function initializeDatabase() {
  try {
    // Wait for connection
    if (mongoose.connection.readyState !== 1) {
      await new Promise(resolve => {
        mongoose.connection.once('connected', resolve);
      });
    }

    console.log('Connected to MongoDB, dropping collections...');

    try {
      await mongoose.connection.db.dropCollection('users');
      console.log('Dropped users collection');
    } catch (e) {
      console.log('Users collection may not exist');
    }
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Initialize database and set up models
(async () => {
  try {
    await initializeDatabase();
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
})();

export { initializeDatabase };
