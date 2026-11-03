const ACTIVE_TTL_MS = 75_000;

const HEARTBEAT_SCRIPT = `
local now = tonumber(ARGV[1])
redis.call('ZADD', KEYS[1], now, ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ${ACTIVE_TTL_MS})
return redis.call('ZCARD', KEYS[1])
`;

// One atomic operation: update presence, then pair two waiting players.
const MATCHMAKING_SCRIPT = `
local now = tonumber(ARGV[1])
local session = ARGV[2]
local peer = ARGV[3]
local activeKey = KEYS[1]
local queueKey = KEYS[2]

redis.call('ZADD', activeKey, now, session)
redis.call('ZREMRANGEBYSCORE', activeKey, '-inf', now - ${ACTIVE_TTL_MS})
local online = redis.call('ZCARD', activeKey)

local myMatchKey = 'kusa:mm:' .. session
local existing = redis.call('GET', myMatchKey)
if existing then
  return {'matched', existing, tostring(online)}
end

redis.call('SET', 'kusa:peer:' .. session, peer, 'EX', 60)
redis.call('ZREMRANGEBYSCORE', queueKey, '-inf', now - 45000)

if not redis.call('ZSCORE', queueKey, session) then
  local candidates = redis.call('ZRANGE', queueKey, 0, 19)
  for _, other in ipairs(candidates) do
    if other ~= session then
      local otherPeer = redis.call('GET', 'kusa:peer:' .. other)
      redis.call('ZREM', queueKey, other)
      if otherPeer and otherPeer ~= peer then
        redis.call('SET', myMatchKey, otherPeer, 'EX', 120)
        redis.call('SET', 'kusa:mm:' .. other, peer, 'EX', 120)
        return {'matched', otherPeer, tostring(online)}
      end
    end
  end
end

redis.call('ZADD', queueKey, now, session)
return {'waiting', '', tostring(online)}
`;

// The room key holds one waiting player. Lua makes joining the same code atomic.
const ROOM_SCRIPT = `
local now = tonumber(ARGV[1])
local session = ARGV[2]
local peer = ARGV[3]
local code = ARGV[4]
local activeKey = KEYS[1]

redis.call('ZADD', activeKey, now, session)
redis.call('ZREMRANGEBYSCORE', activeKey, '-inf', now - ${ACTIVE_TTL_MS})
local online = redis.call('ZCARD', activeKey)

local myMatchKey = 'kusa:rm:' .. session
local existing = redis.call('GET', myMatchKey)
if existing then
  return {'matched', existing, tostring(online)}
end

local roomKey = 'kusa:room:' .. code
local raw = redis.call('GET', roomKey)
if not raw then
  redis.call('SET', roomKey, cjson.encode({s = session, p = peer}), 'EX', 45)
  return {'waiting', '', tostring(online)}
end

local ok, first = pcall(cjson.decode, raw)
if not ok or not first or not first.s or not first.p then
  redis.call('DEL', roomKey)
  redis.call('SET', roomKey, cjson.encode({s = session, p = peer}), 'EX', 45)
  return {'waiting', '', tostring(online)}
end

if first.s == session then
  redis.call('EXPIRE', roomKey, 45)
  return {'waiting', '', tostring(online)}
end

redis.call('SET', myMatchKey, first.p, 'EX', 120)
redis.call('SET', 'kusa:rm:' .. first.s, peer, 'EX', 120)
redis.call('DEL', roomKey)
return {'matched', first.p, tostring(online)}
`;

const CANCEL_SCRIPT = `
local session = ARGV[1]
local code = ARGV[2]
local removeActive = ARGV[3]
redis.call('ZREM', KEYS[2], session)
redis.call('DEL', 'kusa:peer:' .. session)
redis.call('DEL', 'kusa:mm:' .. session)
redis.call('DEL', 'kusa:rm:' .. session)
if code and string.len(code) > 0 then
  local roomKey = 'kusa:room:' .. code
  local raw = redis.call('GET', roomKey)
  if raw then
    local ok, entry = pcall(cjson.decode, raw)
    if ok and entry and entry.s == session then
      redis.call('DEL', roomKey)
    end
  end
end
if removeActive == '1' then
  redis.call('ZREM', KEYS[1], session)
end
return 1
`;

function validSession(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{12,64}$/.test(value);
}

function validPeer(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{4,128}$/.test(value);
}

function validRoom(value) {
  return typeof value === 'string' && /^[a-z0-9]{2,12}$/.test(value);
}

async function redisEval(script, keys, args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const error = new Error('Upstashの環境変数が未設定です。VercelにUPSTASH_REDIS_REST_URLとUPSTASH_REDIS_REST_TOKENを設定してください。');
    error.status = 503;
    throw error;
  }

  const endpoint = url.replace(/\/+$/, '');
  const command = ['EVAL', script, String(keys.length), ...keys, ...args.map(String)];
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Upstashとの通信に失敗しました (${response.status})`);
  }
  return payload.result;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POSTのみ対応しています。' });
  }

  const body = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});

  const { action, sessionId, peerId } = body;
  if (!validSession(sessionId)) {
    return res.status(400).json({ error: 'セッションIDが不正です。ページを再読み込みしてください。' });
  }

  try {
    const now = Date.now();

    if (action === 'heartbeat') {
      const count = await redisEval(HEARTBEAT_SCRIPT, ['kusa:active'], [now, sessionId]);
      return res.status(200).json({ online: Number(count) || 0 });
    }

    if (action === 'matchmake') {
      if (!validPeer(peerId)) return res.status(400).json({ error: 'Peer IDが不正です。' });
      const result = await redisEval(
        MATCHMAKING_SCRIPT,
        ['kusa:active', 'kusa:queue'],
        [now, sessionId, peerId]
      );
      return res.status(200).json({
        status: result?.[0] || 'waiting',
        peerId: result?.[1] || null,
        online: Number(result?.[2] ?? result?.[1]) || 0
      });
    }

    if (action === 'room-join') {
      if (!validPeer(peerId)) return res.status(400).json({ error: 'Peer IDが不正です。' });
      if (!validRoom(body.roomCode)) return res.status(400).json({ error: '部屋コードは半角英数字2〜12文字にしてください。' });
      const result = await redisEval(
        ROOM_SCRIPT,
        ['kusa:active'],
        [now, sessionId, peerId, body.roomCode]
      );
      return res.status(200).json({
        status: result?.[0] || 'waiting',
        peerId: result?.[1] || null,
        online: Number(result?.[2] ?? result?.[1]) || 0
      });
    }

    if (action === 'cancel' || action === 'leave') {
      const code = validRoom(body.roomCode) ? body.roomCode : '';
      await redisEval(
        CANCEL_SCRIPT,
        ['kusa:active', 'kusa:queue'],
        [sessionId, code, action === 'leave' ? '1' : '0']
      );
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '不明な操作です。' });
  } catch (error) {
    console.error('match API:', error);
    return res.status(error.status || 500).json({ error: error.message || 'サーバー内部エラーです。' });
  }
}
