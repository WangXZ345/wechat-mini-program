const session = require("./session");
const {
  markDirty,
  clearProductPreview
} = require("./performanceCache");

const POLL_INTERVAL_MS = 1800;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const STATE_STORAGE_KEY = "sync_state_v2";
const MAX_SEEN_EVENTS = 256;

let running = false;
let visible = true;
let online = true;
let timer = null;
let inFlight = null;
let retryCount = 0;
let cursor = "";
let stateScope = "";
let nextSubscriptionId = 1;
let networkListenerInstalled = false;
const subscriptions = new Map();
const seenEventHashes = [];
const seenEventHashSet = new Set();

function hashText(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function currentScope() {
  const login = session.getLoginSession();
  if (!login) return "";
  const user = login.user || {};
  const profile = login.adminProfile || {};
  return hashText(JSON.stringify([
    user._id || user.id || user.userId || user.openid || "user",
    profile._id || profile.id || "",
    login.role || profile.role || "user"
  ]));
}

function rememberEvent(eventId) {
  const value = hashText(eventId);
  if (!value || seenEventHashSet.has(value)) return false;
  seenEventHashes.push(value);
  seenEventHashSet.add(value);
  while (seenEventHashes.length > MAX_SEEN_EVENTS) {
    seenEventHashSet.delete(seenEventHashes.shift());
  }
  return true;
}

function readState() {
  const scope = currentScope();
  if (!scope) return false;
  if (scope === stateScope) return true;
  stateScope = scope;
  cursor = "";
  seenEventHashes.length = 0;
  seenEventHashSet.clear();
  try {
    const stored = wx.getStorageSync(STATE_STORAGE_KEY);
    if (!stored || stored.scope !== scope) return true;
    cursor = String(stored.cursor || "");
    (stored.seen || []).slice(-MAX_SEEN_EVENTS).forEach((value) => {
      const hash = String(value || "");
      if (!hash || seenEventHashSet.has(hash)) return;
      seenEventHashes.push(hash);
      seenEventHashSet.add(hash);
    });
  } catch (err) {
    cursor = "";
  }
  return true;
}

function writeState() {
  if (!stateScope) return;
  try {
    wx.setStorageSync(STATE_STORAGE_KEY, {
      scope: stateScope,
      cursor,
      seen: seenEventHashes.slice(-MAX_SEEN_EVENTS),
      updatedAt: Date.now()
    });
  } catch (err) {
    // A storage failure only removes catch-up persistence for the next launch.
  }
}

function currentPage() {
  try {
    const pages = getCurrentPages();
    return pages && pages[pages.length - 1] || null;
  } catch (err) {
    return null;
  }
}

function activeSubscriptions() {
  const page = currentPage();
  return Array.from(subscriptions.values()).filter((subscription) => !subscription.owner || subscription.owner === page);
}

function activeTopics() {
  const topics = new Set();
  activeSubscriptions().forEach((subscription) => subscription.topics.forEach((topic) => topics.add(topic)));
  return Array.from(topics).sort();
}

function clearTimer() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

function schedule(delay = POLL_INTERVAL_MS) {
  clearTimer();
  if (!running || !visible || !online) return;
  timer = setTimeout(poll, Math.max(0, Number(delay || 0)));
}

function invalidate(events) {
  (events || []).forEach((event) => {
    const type = String(event.entityType || "");
    if (type === "product" || type === "inventory") {
      markDirty("products");
      if (event.entityId) clearProductPreview(event.entityId);
    }
    if (["order", "payment", "shipment", "after_sale", "refund"].includes(type)) {
      markDirty("order");
    }
    if (type === "account") markDirty("profile");
  });
}

function dispatch(events) {
  if (!events.length) return;
  invalidate(events);
  activeSubscriptions().forEach((subscription) => {
    const matching = events.filter((event) => subscription.topics.has(String(event.entityType || "")));
    if (!matching.length) return;
    try {
      subscription.handler(matching);
    } catch (err) {
      console.warn("sync subscriber failed", String(err && err.message || err || "").slice(0, 120));
    }
  });
}

function resultData(response) {
  const result = response && response.result || {};
  if (!result.ok) {
    const error = new Error(result.message || "Sync request failed");
    error.code = result.code || "SYNC_READ_FAILED";
    throw error;
  }
  return result.data || {};
}

function poll() {
  if (inFlight) return inFlight;
  if (!running || !visible || !online || !readState()) return Promise.resolve();
  const topics = activeTopics();
  if (!topics.length) {
    schedule();
    return Promise.resolve();
  }
  inFlight = wx.cloud.callFunction({
    name: "getSyncEvents",
    data: { cursor, topics, limit: 100 }
  }).then(resultData).then((data) => {
    retryCount = 0;
    if (data.nextCursor) cursor = String(data.nextCursor);
    const events = (data.events || []).filter((event) => event && event.eventId && rememberEvent(event.eventId));
    writeState();
    dispatch(events);
    schedule(data.hasMore ? 0 : POLL_INTERVAL_MS);
  }).catch((err) => {
    if (err && err.code === "INVALID_SYNC_CURSOR") {
      cursor = "";
      writeState();
      schedule(0);
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
    retryCount += 1;
    schedule(delay + Math.floor(Math.random() * 250));
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function installNetworkListener() {
  if (networkListenerInstalled || typeof wx.onNetworkStatusChange !== "function") return;
  networkListenerInstalled = true;
  wx.onNetworkStatusChange((status) => {
    online = status && status.isConnected !== false;
    if (online) {
      retryCount = 0;
      schedule(0);
    } else {
      clearTimer();
    }
  });
}

function start() {
  if (!session.hasLoginSession()) return false;
  running = true;
  visible = true;
  installNetworkListener();
  readState();
  schedule(0);
  return true;
}

function pause() {
  visible = false;
  clearTimer();
}

function resume() {
  visible = true;
  return start();
}

function stop() {
  running = false;
  clearTimer();
}

function subscribe(owner, topics, handler) {
  const id = nextSubscriptionId++;
  const topicSet = new Set((Array.isArray(topics) ? topics : [topics]).map((topic) => String(topic || "")).filter(Boolean));
  subscriptions.set(id, {
    owner,
    topics: topicSet,
    handler: typeof handler === "function" ? handler : () => {}
  });
  start();
  schedule(0);
  return () => {
    subscriptions.delete(id);
    if (!subscriptions.size) clearTimer();
  };
}

module.exports = {
  POLL_INTERVAL_MS,
  start,
  pause,
  resume,
  stop,
  subscribe,
  poll,
  _test: {
    hashText,
    rememberEvent,
    invalidate
  }
};
