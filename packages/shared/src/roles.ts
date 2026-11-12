export const USER_ROLES = ["admin", "comercial"] as const;
export type UserRole = (typeof USER_ROLES)[number];
