/** Minimal HS256 JWT implementation on Web Crypto (no dependencies). */

export interface JwtClaims {
  sub: string;
  kind: "guest" | "key";
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signJwt(
  claims: Omit<JwtClaims, "iat" | "exp">,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Returns the claims when the signature is valid and the token is unexpired, else null. */
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64UrlDecode(signature),
      encoder.encode(`${header}.${payload}`),
    );
    if (!valid) return null;
    const { alg } = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as { alg?: string };
    if (alg !== "HS256") return null;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as JwtClaims;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
