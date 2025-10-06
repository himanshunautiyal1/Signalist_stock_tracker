import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

console.log("✅ Loaded GEMINI_API_KEY:", process.env.GEMINI_API_KEY);
