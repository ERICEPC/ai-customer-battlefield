import {
  createHash,
  scrypt as nodeScrypt,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { IdentityProfile, IdentityStore } from "./identity-store.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const SCRYPT_KEY_LENGTH = 64;
const DEFAULT_SCRYPT_COST = 16_384;
const DEFAULT_SCRYPT_BLOCK_SIZE = 8;
const DEFAULT_SCRYPT_PARALLELIZATION = 1;
const DUMMY_PASSWORD_HASH = `scrypt$${DEFAULT_SCRYPT_COST}$${DEFAULT_SCRYPT_BLOCK_SIZE}$${DEFAULT_SCRYPT_PARALLELIZATION}$${"0".repeat(32)}$${"0".repeat(128)}`;

export interface SessionProfile extends IdentityProfile {
  expiresAt: string;
}

export interface AuthenticatedIdentity {
  actor: { tenantId: string; userId: string };
  sessionId: string;
  session: SessionProfile;
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("The supplied login credentials are invalid.");
    this.name = "InvalidCredentialsError";
  }
}

export class InvalidSessionConfigurationError extends Error {
  constructor() {
    super("Session configuration is invalid.");
    this.name = "InvalidSessionConfigurationError";
  }
}

export class AuthenticateSession {
  constructor(
    private readonly dependencies: {
      store: IdentityStore;
      clock: { now(): Date };
      idGenerator: { next(): string };
      tokenGenerator: { next(): string };
      sessionDurationMs: number;
    },
  ) {
    if (
      !Number.isInteger(dependencies.sessionDurationMs) ||
      dependencies.sessionDurationMs < 60_000
    ) {
      throw new InvalidSessionConfigurationError();
    }
  }

  async execute(input: {
    tenantSlug: string;
    email: string;
    password: string;
  }): Promise<{
    cookieValue: string;
    sessionId: string;
    session: SessionProfile;
  }> {
    const now = this.dependencies.clock.now();
    const account = await this.dependencies.store.findLoginAccount({
      tenantSlug: input.tenantSlug,
      email: input.email,
    });
    const passwordMatches = await verifyPassword(
      input.password,
      account?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    const locked =
      account?.lockedUntil !== null &&
      account?.lockedUntil !== undefined &&
      Date.parse(account.lockedUntil) > now.getTime();
    if (!account || !passwordMatches || locked) {
      throw new InvalidCredentialsError();
    }

    const sessionId = this.dependencies.idGenerator.next();
    const token = this.dependencies.tokenGenerator.next();
    if (!UUID_PATTERN.test(sessionId) || !SESSION_TOKEN_PATTERN.test(token)) {
      throw new InvalidSessionConfigurationError();
    }
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + this.dependencies.sessionDurationMs,
    ).toISOString();
    await this.dependencies.store.createSession({
      actor: { tenantId: account.tenantId, userId: account.userId },
      sessionId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      createdAt,
    });

    return {
      cookieValue: `${account.tenantId}.${token}`,
      sessionId,
      session: { ...account.profile, expiresAt },
    };
  }
}

export class ResolveSession {
  constructor(
    private readonly dependencies: {
      store: IdentityStore;
      clock: { now(): Date };
    },
  ) {}

  async execute(input: {
    cookieValue: string;
  }): Promise<AuthenticatedIdentity | null> {
    const separator = input.cookieValue.indexOf(".");
    if (separator < 0) return null;
    const tenantId = input.cookieValue.slice(0, separator);
    const token = input.cookieValue.slice(separator + 1);
    if (!UUID_PATTERN.test(tenantId) || !SESSION_TOKEN_PATTERN.test(token)) {
      return null;
    }

    const stored = await this.dependencies.store.resolveSession({
      tenantId,
      tokenHash: hashSessionToken(token),
      now: this.dependencies.clock.now().toISOString(),
    });
    if (!stored || stored.tenantId !== tenantId) return null;
    return {
      actor: { tenantId: stored.tenantId, userId: stored.userId },
      sessionId: stored.sessionId,
      session: { ...stored.profile, expiresAt: stored.expiresAt },
    };
  }
}

export class RevokeSession {
  constructor(
    private readonly dependencies: {
      store: IdentityStore;
      clock: { now(): Date };
    },
  ) {}

  async execute(input: {
    actor: { tenantId: string; userId: string };
    sessionId: string;
  }): Promise<void> {
    await this.dependencies.store.revokeSession({
      ...input,
      revokedAt: this.dependencies.clock.now().toISOString(),
    });
  }
}

export async function hashPassword(
  password: string,
  options: { salt?: Buffer } = {},
): Promise<string> {
  const salt = options.salt ?? randomBytes(16);
  const derivedKey = await scrypt(password, salt, {
    cost: DEFAULT_SCRYPT_COST,
    blockSize: DEFAULT_SCRYPT_BLOCK_SIZE,
    parallelization: DEFAULT_SCRYPT_PARALLELIZATION,
  });
  return [
    "scrypt",
    DEFAULT_SCRYPT_COST,
    DEFAULT_SCRYPT_BLOCK_SIZE,
    DEFAULT_SCRYPT_PARALLELIZATION,
    salt.toString("hex"),
    derivedKey.toString("hex"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const [
    algorithm,
    costText,
    blockSizeText,
    parallelizationText,
    saltHex,
    keyHex,
  ] = encodedHash.split("$");
  if (
    algorithm !== "scrypt" ||
    !costText ||
    !blockSizeText ||
    !parallelizationText ||
    !saltHex ||
    !keyHex ||
    !/^[a-f0-9]{32}$/.test(saltHex) ||
    !/^[a-f0-9]{128}$/.test(keyHex)
  ) {
    return false;
  }
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (
    cost !== DEFAULT_SCRYPT_COST ||
    blockSize !== DEFAULT_SCRYPT_BLOCK_SIZE ||
    parallelization !== DEFAULT_SCRYPT_PARALLELIZATION
  ) {
    return false;
  }
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), {
    cost,
    blockSize,
    parallelization,
  });
  return timingSafeEqual(expected, actual);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function randomSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function scrypt(
  password: string,
  salt: Buffer,
  options: { cost: number; blockSize: number; parallelization: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: options.cost,
        r: options.blockSize,
        p: options.parallelization,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}
