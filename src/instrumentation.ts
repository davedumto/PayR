import { getEnv } from "@/env";

// Runs once when the Node.js server starts. Throws with a readable message if
// configuration is missing or malformed, so a bad deploy fails at boot.
export function register(): void {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    getEnv();
  }
}
