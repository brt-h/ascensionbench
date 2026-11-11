// Ascension Bench stream status: a Cloudflare Pages Function serving GET /stream-status.json on the site (the path
// the landing page fetches once a minute). It asks Twitch (Helix, app access token from the client credentials)
// whether the channel is live and parses the public stream title, which the supervisor sets
// (stream/mirror_supervise.py): "<model> (<effort>) · A<n> · live" during an evaluation game and
// "<model> (<effort>) · A<n> · floor <f> · replay, recorded <t>" during a replay. Nothing private is involved.
// Twitch is asked at most once a minute per edge location (Cache API); the app token is cached until shortly
// before it expires. Secrets TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are set on the Pages project, never here.
// Optional var CHANNEL (default ascensionbench). Published by copying site/functions/ into the public site clone.

const STATUS_KEY = "https://status.ascensionbench.invalid/v1";
const TOKEN_KEY = "https://status.ascensionbench.invalid/token";
const TTL = 60;  // seconds a status answer is reused

const GAME = /^(?:Benchmarking )?(.+?) \((\w+)\) · A(\d+) · live$/;
const REPLAY = /^(?:Replaying )?(.+?) \((\w+)\) · A(\d+)(?: · floor (\d+))? · replay(?:, recorded (.+))?$/;

export async function onRequestGet({ env, waitUntil }) {
  const cache = caches.default;
  let response = await cache.match(STATUS_KEY);
  if (!response) {
    response = await build(env, cache);
    waitUntil(cache.put(STATUS_KEY, response.clone()));
  }
  return response;
}

async function build(env, cache) {
  const channel = env.CHANNEL || "ascensionbench";
  const body = { channel, watch: `https://www.twitch.tv/${channel}`, checked_at: new Date().toISOString(), live: null };
  let status = 200, ttl = TTL;
  try {
    const stream = await streamOf(channel, env, cache);
    body.live = stream !== null;
    if (stream) {
      body.title = stream.title;
      body.started_at = stream.started_at;
      body.viewers = stream.viewer_count;
      Object.assign(body, parseTitle(stream.title));
    } else {
      body.activity = "offline";
    }
  } catch (err) {
    body.error = "twitch_unavailable";
    body.activity = "unknown";
    ttl = 30;
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttl}`,
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

function parseTitle(title) {
  let m = GAME.exec(title);
  if (m) return { activity: "evaluating", model: m[1], effort: m[2], ascension: Number(m[3]) };
  m = REPLAY.exec(title);
  if (m) {
    const out = { activity: "replaying", model: m[1], effort: m[2], ascension: Number(m[3]) };
    if (m[4]) out.floor = Number(m[4]);
    if (m[5]) out.recorded = m[5];
    return out;
  }
  return { activity: "live" };
}

async function streamOf(channel, env, cache, retry = true) {
  const token = await appToken(env, cache);
  const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`, {
    headers: { "client-id": env.TWITCH_CLIENT_ID, authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && retry) {
    await cache.delete(TOKEN_KEY);
    return streamOf(channel, env, cache, false);
  }
  if (!res.ok) throw new Error(`helix ${res.status}`);
  const data = (await res.json()).data || [];
  return data.length ? data[0] : null;
}

async function appToken(env, cache) {
  const cached = await cache.match(TOKEN_KEY);
  if (cached) return (await cached.json()).access_token;
  const form = new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: "client_credentials" });
  const res = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body: form });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const tok = await res.json();
  const ttl = Math.max(60, Math.min(Number(tok.expires_in || 3600) - 600, 30 * 86400));
  await cache.put(TOKEN_KEY, new Response(JSON.stringify({ access_token: tok.access_token }), {
    headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
  }));
  return tok.access_token;
}
