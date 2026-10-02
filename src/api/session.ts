import { Hono } from "hono";
import { extractToken } from "../auth/principal";
import { signJwt, verifyJwt } from "../auth/jwt";
import { audit } from "../lib/audit";
import { AppError, rateLimited } from "../lib/errors";
import { newId } from "../lib/ids";
import { dailyBudget, tokensUsedToday } from "../lib/usage";
import { type AppEnv, clientIp, requireAuth } from "./context";

const GUEST_TTL_SECONDS = 24 * 60 * 60;

export const sessionRoutes = new Hono<AppEnv>()
  /**
   * Issues a guest token. Sending a still-valid guest token refreshes it for the
   * same user, so a returning visitor keeps their conversations and documents.
   */
  .post("/session", async (c) => {
    if (!c.env.JWT_SECRET?.trim()) throw new AppError(503, "auth_disabled", "JWT_SECRET is not configured");
    const ip = clientIp(c);

    const existing = extractToken(c.req.raw);
    const claims = existing ? await verifyJwt(existing, c.env.JWT_SECRET) : null;
    if (claims?.kind === "guest") {
      const token = await signJwt({ sub: claims.sub, kind: "guest" }, c.env.JWT_SECRET, GUEST_TTL_SECONDS);
      return c.json({ token, userId: claims.sub, kind: "guest", expiresIn: GUEST_TTL_SECONDS, refreshed: true });
    }

    const { success } = await c.env.SESSION_LIMITER.limit({ key: `session:${ip}` });
    if (!success) throw rateLimited("Too many new sessions from this network, try again in a minute");

    const userId = newId("usr");
    await c.env.DB.prepare(`INSERT INTO users (id, kind, created_at) VALUES (?, 'guest', ?)`)
      .bind(userId, Date.now())
      .run();
    const token = await signJwt({ sub: userId, kind: "guest" }, c.env.JWT_SECRET, GUEST_TTL_SECONDS);
    await audit(c.env.DB, { userId, action: "session.created", ip });
    c.get("log").info("guest session created", { userId });
    return c.json({ token, userId, kind: "guest", expiresIn: GUEST_TTL_SECONDS, refreshed: false }, 201);
  })

  .get("/me", requireAuth, async (c) => {
    const principal = c.get("principal");
    const [used, budget] = await Promise.all([
      tokensUsedToday(c.env.DB, principal.userId),
      dailyBudget(c.env, principal.kind),
    ]);
    return c.json({ ...principal, usage: { tokensToday: used, dailyBudget: budget } });
  });
