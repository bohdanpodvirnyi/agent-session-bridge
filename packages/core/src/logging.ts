import { redactSecrets } from "./config.js";

export interface AuditLogEntry {
  level: "info" | "warn" | "error";
  message: string;
}

export function createAuditLogEntry(
  level: AuditLogEntry["level"],
  message: string,
  redactionPatterns: RegExp[],
): AuditLogEntry {
  return {
    level,
    message: redactSecrets(message, redactionPatterns),
  };
}
