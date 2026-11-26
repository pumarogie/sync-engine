import { describe, expect, test } from "bun:test";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { generateKeys, jwks, loadOrCreateKeys, signToken, verifyToken } from "@sync/api/auth";

describe("RS256 auth", async () => {
  const keys = await generateKeys("test-kid");

  test("signed token verifies and yields the subject", async () => {
    const { token } = await signToken(keys, "alice");
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "RS256", kid: "test-kid" });
    expect(await verifyToken(keys, token)).toBe("alice");
  });

  test("token verifies against the published JWKS (what PowerSync and collab do)", async () => {
    const set = jwks(keys);
    expect(set.keys[0]).toMatchObject({ kty: "RSA", kid: "test-kid", alg: "RS256", use: "sig" });
    expect(set.keys[0]).not.toHaveProperty("d"); // never leak the private exponent
    const { token } = await signToken(keys, "bob");
    const { payload } = await jwtVerify(token, createLocalJWKSet(set), { audience: "powersync" });
    expect(payload.sub).toBe("bob");
  });

  test("rejects tokens from another key, expired tokens and wrong audience", async () => {
    const other = await generateKeys("other");
    await expect(verifyToken(keys, (await signToken(other, "eve")).token)).rejects.toThrow();
    const expired = await signToken(keys, "alice", Math.floor(Date.now() / 1000) - 7200);
    await expect(verifyToken(keys, expired.token)).rejects.toThrow();
    const wrongAud = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: keys.kid })
      .setSubject("alice")
      .setIssuer("sync-engine-api")
      .setAudience("someone-else")
      .setExpirationTime("1h")
      .sign(keys.privateKey);
    await expect(verifyToken(keys, wrongAud)).rejects.toThrow();
  });

  test("dev keypair persists across restarts", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/sync-engine-test-${crypto.randomUUID()}/jwk.json`;
    const first = await loadOrCreateKeys(path);
    const second = await loadOrCreateKeys(path);
    expect(second.kid).toBe(first.kid);
    expect(await verifyToken(second, (await signToken(first, "alice")).token)).toBe("alice");
  });
});
