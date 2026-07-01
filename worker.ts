/* ============================================================
   Redirection — Cloudflare Worker backend
   Deploy this with Wrangler. It handles:
     - account signup / login          (POST /api/signup, /api/login)
     - listing / creating / deleting   (GET|POST /api/links, DELETE /api/links/:code)
     - the actual public redirect      (GET /r/:code)
   Storage: Cloudflare Workers KV (binding name: LINKS_KV)
   ============================================================ */

export interface Env {
  LINKS_KV: KVNamespace;
  // Comma-separated list of origins allowed to call the API,
  // e.g. "https://yourname.github.io". Set in wrangler.toml or
  // as a dashboard secret/variable. Falls back to "*" if unset.
  ALLOWED_ORIGIN?: string;
}

interface UserRecord {
  passHash: string;
  createdAt: number;
}

interface LinkRecord {
  code: string;
  dest: string;
  owner: string;
  clicks: number;
  createdAt: number;
}

interface SessionRecord {
  email: string;
  createdAt: number;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function err(message: string, status: number, env: Env): Response {
  return json({ error: message }, status, env);
}

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeUrl(url: string): string {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

function genCode(): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function getSessionEmail(request: Request, env: Env): Promise<string | null> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const raw = await env.LINKS_KV.get(`session:${token}`);
  if (!raw) return null;
  const session = JSON.parse(raw) as SessionRecord;
  return session.email;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    // ---------------------------------------------------------------
    // Public redirect: GET /r/:code
    // ---------------------------------------------------------------
    const redirectMatch = path.match(/^\/r\/([^/]+)$/);
    if (redirectMatch && method === "GET") {
      const code = decodeURIComponent(redirectMatch[1]);
      const raw = await env.LINKS_KV.get(`link:${code}`);
      if (!raw) {
        return new Response(`No route found for /${code}`, { status: 404 });
      }
      const link = JSON.parse(raw) as LinkRecord;
      link.clicks = (link.clicks || 0) + 1;
      await env.LINKS_KV.put(`link:${code}`, JSON.stringify(link));
      return Response.redirect(link.dest, 302);
    }

    // ---------------------------------------------------------------
    // POST /api/signup  { email, password }
    // ---------------------------------------------------------------
    if (path === "/api/signup" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";

      if (!email || !password) return err("Email and password are required.", 400, env);
      if (password.length < 6) return err("Password needs to be at least 6 characters.", 400, env);

      const existing = await env.LINKS_KV.get(`user:${email}`);
      if (existing) return err("An account with that email already exists.", 409, env);

      const passHash = await hashPassword(password);
      const user: UserRecord = { passHash, createdAt: Date.now() };
      await env.LINKS_KV.put(`user:${email}`, JSON.stringify(user));

      const token = crypto.randomUUID();
      await env.LINKS_KV.put(
        `session:${token}`,
        JSON.stringify({ email, createdAt: Date.now() } satisfies SessionRecord),
        { expirationTtl: SESSION_TTL_SECONDS }
      );

      return json({ token, email }, 201, env);
    }

    // ---------------------------------------------------------------
    // POST /api/login  { email, password }
    // ---------------------------------------------------------------
    if (path === "/api/login" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";

      const raw = await env.LINKS_KV.get(`user:${email}`);
      if (!raw) return err("Email or password is incorrect.", 401, env);
      const user = JSON.parse(raw) as UserRecord;

      const passHash = await hashPassword(password);
      if (passHash !== user.passHash) return err("Email or password is incorrect.", 401, env);

      const token = crypto.randomUUID();
      await env.LINKS_KV.put(
        `session:${token}`,
        JSON.stringify({ email, createdAt: Date.now() } satisfies SessionRecord),
        { expirationTtl: SESSION_TTL_SECONDS }
      );

      return json({ token, email }, 200, env);
    }

    // ---------------------------------------------------------------
    // POST /api/logout
    // ---------------------------------------------------------------
    if (path === "/api/logout" && method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token) await env.LINKS_KV.delete(`session:${token}`);
      return json({ ok: true }, 200, env);
    }

    // ---------------------------------------------------------------
    // GET /api/links  (list current user's links)
    // POST /api/links { dest, code? }  (create a link)
    // ---------------------------------------------------------------
    if (path === "/api/links" && method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return err("Not authenticated.", 401, env);

      const list = await env.LINKS_KV.list({ prefix: `ownerlink:${email}:` });
      const codes = list.keys.map((k) => k.name.split(":").slice(2).join(":"));
      const links: LinkRecord[] = [];
      for (const code of codes) {
        const raw = await env.LINKS_KV.get(`link:${code}`);
        if (raw) links.push(JSON.parse(raw));
      }
      links.sort((a, b) => b.createdAt - a.createdAt);
      return json({ links }, 200, env);
    }

    if (path === "/api/links" && method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return err("Not authenticated.", 401, env);

      const body = (await request.json().catch(() => ({}))) as { dest?: string; code?: string };
      const destRaw = (body.dest || "").trim();
      if (!destRaw) return err("A destination URL is required.", 400, env);
      const dest = normalizeUrl(destRaw);

      let code = (body.code || "").trim().replace(/[^a-zA-Z0-9\-_]/g, "");
      if (code) {
        const existing = await env.LINKS_KV.get(`link:${code}`);
        if (existing) return err("That code is taken — try another.", 409, env);
      } else {
        do {
          code = genCode();
        } while (await env.LINKS_KV.get(`link:${code}`));
      }

      const link: LinkRecord = { code, dest, owner: email, clicks: 0, createdAt: Date.now() };
      await env.LINKS_KV.put(`link:${code}`, JSON.stringify(link));
      await env.LINKS_KV.put(`ownerlink:${email}:${code}`, "1");

      return json({ link }, 201, env);
    }

    // ---------------------------------------------------------------
    // DELETE /api/links/:code
    // ---------------------------------------------------------------
    const deleteMatch = path.match(/^\/api\/links\/([^/]+)$/);
    if (deleteMatch && method === "DELETE") {
      const email = await getSessionEmail(request, env);
      if (!email) return err("Not authenticated.", 401, env);

      const code = decodeURIComponent(deleteMatch[1]);
      const raw = await env.LINKS_KV.get(`link:${code}`);
      if (!raw) return err("Link not found.", 404, env);
      const link = JSON.parse(raw) as LinkRecord;
      if (link.owner !== email) return err("You don't own this link.", 403, env);

      await env.LINKS_KV.delete(`link:${code}`);
      await env.LINKS_KV.delete(`ownerlink:${email}:${code}`);
      return json({ ok: true }, 200, env);
    }

    return err("Not found.", 404, env);
  },
};

