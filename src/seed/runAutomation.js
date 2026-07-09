import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from '../config/db.js';
import { runAutomation } from '../utils/automation.js';
import mongoose from 'mongoose';

await connectDB();
const result = await runAutomation();
console.log(result);
await mongoose.disconnect();
