// nesta-server/checkEnv.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// figure out current dir
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load .env from nesta-server
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

console.log("=== ENV CHECK ===");
console.log("env file path:", envPath);
console.log("env file exists?", fs.existsSync(envPath));

console.log("PORT =", process.env.PORT);
console.log("NESTA_FAKE_DB =", process.env.NESTA_FAKE_DB);
console.log("GOOGLE_APPLICATION_CREDENTIALS =", process.env.GOOGLE_APPLICATION_CREDENTIALS);

// also check the serviceAccountKey.json file
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const abs = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    ? process.env.GOOGLE_APPLICATION_CREDENTIALS
    : path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS);

  console.log("Resolved creds path:", abs);
  console.log("Creds file exists?", fs.existsSync(abs));
}
console.log("================="); 