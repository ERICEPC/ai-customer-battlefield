import { z } from "zod";

export const identityRoleSchema = z.enum(["sales", "department_leader"]);

export const loginRequestSchema = z.strictObject({
  tenantSlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  password: z.string().min(8).max(200),
});

export const identityPersonSchema = z.strictObject({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(200),
});

export const sessionProfileSchema = z.strictObject({
  user: identityPersonSchema.extend({ email: z.email().max(320) }),
  role: identityRoleSchema,
  department: z.strictObject({
    id: z.uuid(),
    name: z.string().trim().min(1).max(200),
  }),
  directLeader: identityPersonSchema.nullable(),
  teamMembers: z.array(identityPersonSchema).max(500),
  expiresAt: z.iso.datetime(),
});

export const loginResponseSchema = z.strictObject({
  session: sessionProfileSchema,
});

export const authApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_LOGIN_REQUEST",
    "INVALID_CREDENTIALS",
    "AUTHENTICATION_REQUIRED",
    "AUTHENTICATION_UNAVAILABLE",
  ]),
  message: z.string().trim().min(1).max(1_000),
  requestId: z.string().trim().min(1).max(200),
});

export type IdentityRole = z.infer<typeof identityRoleSchema>;
export type IdentityPerson = z.infer<typeof identityPersonSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type SessionProfile = z.infer<typeof sessionProfileSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type AuthApiError = z.infer<typeof authApiErrorSchema>;
