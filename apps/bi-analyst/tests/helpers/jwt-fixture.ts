import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";

export async function createTestJwtFixture(options?: {
  issuer?: string;
  audience?: string;
}): Promise<{
  jwks: { keys: JWK[] };
  sign(claims: Record<string, unknown>, expiresInSec?: number): Promise<string>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwk.kid = "test-key-1";
  const jwks = { keys: [jwk] };
  const issuer = options?.issuer ?? "https://auth.test.local";
  const audience = options?.audience ?? "bi-analyst";

  return {
    jwks,
    async sign(claims, expiresInSec = 3600) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(expiresInSec < 0 ? now + expiresInSec - 60 : now)
        .setExpirationTime(
          expiresInSec < 0 ? now + expiresInSec : now + expiresInSec,
        )
        .sign(privateKey);
    },
  };
}
