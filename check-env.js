import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

if (!process.env.GEMINI_API_KEY) {
  console.warn("GEMINI_API_KEY is missing from the environment");
}
