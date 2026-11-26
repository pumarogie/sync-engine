import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { JWT_AUDIENCE, JWT_ISSUER } from "@sync/shared";
import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type CryptoKey, type JWK } from "jose";

export const JWT_ALG = "RS256";
const TOKEN_TTL_SECONDS = 60 * 60;

export type Keys = { kid: string; privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JWK };

async function fromPrivateJwk(jwk: JWK): Promise<Keys> {
  const kid = jwk.kid ?? "dev";
  const { d, p, q, dp, dq, qi, ...pub } = jwk;
  const publicJwk: JWK = { ...pub, kid, alg: JWT_ALG, use: "sig" };
  return {
    kid,
    privateKey: (await importJWK(jwk, JWT_ALG)) as CryptoKey,
    publicKey: (await importJWK(publicJwk, JWT_ALG)) as CryptoKey,
    publicJwk,
  };
}

async function generatePrivateJwk(kid = `dev-${crypto.randomUUID().slice(0, 8)}`): Promise<JWK> {
  const { privateKey } = await generateKeyPair(JWT_ALG, { extractable: true });
  return { ...(await exportJWK(privateKey)), kid };
}

export async function generateKeys(kid?: string): Promise<Keys> {
  return fromPrivateJwk(await generatePrivateJwk(kid));
}

/** Loads the RS256 key from `JWT_PRIVATE_JWK` or a JSON file; generates and persists one on first run. */
export async function loadOrCreateKeys(path: string): Promise<Keys> {
  if (process.env.JWT_PRIVATE_JWK) return fromPrivateJwk(JSON.parse(process.env.JWT_PRIVATE_JWK));
  const file = Bun.file(path);
  if (await file.exists()) return fromPrivateJwk(await file.json());
  const jwk = await generatePrivateJwk();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(jwk), { mode: 0o600 });
  return fromPrivateJwk(jwk);
}

export function jwks(keys: Keys): { keys: JWK[] } {
  return { keys: [keys.publicJwk] };
}

export async function signToken(keys: Keys, userId: string, now = Math.floor(Date.now() / 1000)) {
  const expiresAt = now + TOKEN_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: JWT_ALG, kid: keys.kid })
    .setSubject(userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(keys.privateKey);
  return { token, userId, expiresAt };
}

/** Returns the user id (JWT `sub`) or throws. */
export async function verifyToken(keys: Keys, token: string): Promise<string> {
  const { payload } = await jwtVerify(token, keys.publicKey, {
    algorithms: [JWT_ALG],
    audience: JWT_AUDIENCE,
    issuer: JWT_ISSUER,
  });
  if (!payload.sub) throw new Error("token has no subject");
  return payload.sub;
}
