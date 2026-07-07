const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");

const homeScore = document.querySelector("#homeScore");
const awayScore = document.querySelector("#awayScore");
const clockEl = document.querySelector("#clock");
const statusText = document.querySelector("#statusText");
const roomCodeEl = document.querySelector("#roomCode");
const playersEl = document.querySelector("#players");
const joinPanel = document.querySelector("#joinPanel");
const joinForm = document.querySelector("#joinForm");
const nameInput = document.querySelector("#nameInput");
const roomInput = document.querySelector("#roomInput");
const copyLink = document.querySelector("#copyLink");
const copyJoinLink = document.querySelector("#copyJoinLink");
const toast = document.querySelector("#toast");

const FIELD = {
  width: 1280,
  height: 820,
  goalDepth: 48,
  goalWidth: 260,
  playerRadius: 16,
  ballRadius: 8
};
const TICK_RATE = 60;
const SNAPSHOT_RATE = 30;
const DT = 1 / TICK_RATE;
const MAX_TEAM_SIZE = 5;
const MATCH_SECONDS = 5 * 60;
const PEER_ROOM_PREFIX = "glf-static-v1";

const urlParams = new URLSearchParams(location.search);
const savedName = localStorage.getItem("gl-player-name") || "";
const storedRoom = sanitizeRoomCode(localStorage.getItem("gl-room-code"));
const savedRoom = roomCodeFromUrl() || (storedRoom && storedRoom !== "MAIN" ? storedRoom : randomNumericCode());

let selectedTeam = "auto";
let myId = null;
let myTeam = null;
let latestState = null;
let previousState = null;
let lastRenderTime = performance.now();
let camera = { x: 0, y: 0, scale: 1 };
let toastTimer = null;
let peer = null;
let hostConn = null;
let hostRoom = null;
let hostTickTimer = null;
let hostSnapshotTimer = null;
let autoFallbackTimer = null;
let joined = false;
let mode = "idle";
const guestConnections = new Map();

nameInput.value = savedName;
roomInput.value = savedRoom;
setRoomCodeLink(savedRoom);

const keys = {
  up: false,
  down: false,
  left: false,
  right: false,
  sprint: false,
  contain: false,
  pass: false,
  through: false,
  lob: false,
  shoot: false,
  modifier: false,
  support: false
};

const keyMap = new Map([
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["KeyE", "sprint"],
  ["KeyC", "contain"],
  ["KeyS", "pass"],
  ["KeyW", "through"],
  ["KeyA", "lob"],
  ["KeyD", "shoot"],
  ["KeyZ", "modifier"],
  ["KeyQ", "support"]
]);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener("resize", resize);
resize();

document.querySelectorAll(".team-option").forEach((button) => {
  button.addEventListener("click", () => {
    selectedTeam = button.dataset.team;
    document.querySelectorAll(".team-option").forEach((option) => {
      option.classList.toggle("active", option === button);
    });
  });
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  startMatch();
});

copyLink.addEventListener("click", copyCurrentRoomLink);
copyJoinLink.addEventListener("click", copyCurrentRoomLink);

window.addEventListener("keydown", (event) => {
  const mapped = keyMap.get(event.code);
  if (!mapped) return;
  event.preventDefault();
  keys[mapped] = true;
});

window.addEventListener("keyup", (event) => {
  const mapped = keyMap.get(event.code);
  if (!mapped) return;
  event.preventDefault();
  keys[mapped] = false;
});

window.addEventListener("blur", () => {
  for (const key of Object.keys(keys)) keys[key] = false;
  sendInput();
});

setInterval(sendInput, 1000 / 60);
requestAnimationFrame(render);

function startMatch() {
  if (!window.Peer) {
    showToast("PeerJS를 불러오지 못했습니다.");
    return;
  }

  resetNetwork();
  const name = nameInput.value.trim() || "PLAYER";
  const room = sanitizeRoomCode(roomInput.value) || randomNumericCode();
  roomInput.value = room;
  localStorage.setItem("gl-player-name", name);
  localStorage.setItem("gl-room-code", room);
  setRoomCodeLink(room);

  if (selectedTeam === "home") {
    startHost(name, room, false);
  } else if (selectedTeam === "away") {
    startGuest(name, room, false);
  } else {
    startGuest(name, room, true);
  }
}

function resetNetwork() {
  clearInterval(hostTickTimer);
  clearInterval(hostSnapshotTimer);
  clearTimeout(autoFallbackTimer);
  hostTickTimer = null;
  hostSnapshotTimer = null;
  autoFallbackTimer = null;
  guestConnections.clear();
  hostRoom = null;
  hostConn = null;
  joined = false;
  mode = "idle";
  myId = null;
  myTeam = null;
  if (peer && !peer.destroyed) peer.destroy();
  peer = null;
}

function startGuest(name, room, allowHostFallback) {
  mode = "guest";
  showToast(allowHostFallback ? "열린 방을 찾는 중..." : "방에 연결 중...");
  peer = new window.Peer(undefined, peerOptions());

  peer.on("open", (id) => {
    myId = id;
    hostConn = peer.connect(peerRoomId(room), {
      reliable: false,
      metadata: { name, team: selectedTeam }
    });
    setupHostConnection(hostConn, name, room, allowHostFallback);
  });

  peer.on("error", () => {
    if (allowHostFallback && !joined) {
      fallbackToHost(name, room);
    } else if (!joined) {
      showToast("방을 찾지 못했습니다. HOME으로 방을 만들어주세요.");
    }
  });

  if (allowHostFallback) {
    autoFallbackTimer = setTimeout(() => {
      if (!joined) fallbackToHost(name, room);
    }, 1800);
  }
}

function setupHostConnection(conn, name, room, allowHostFallback) {
  conn.on("open", () => {
    conn.send({ type: "join", payload: { name, team: selectedTeam } });
  });

  conn.on("data", (message) => {
    if (message.type === "joined") {
      clearTimeout(autoFallbackTimer);
      handleJoined(message.payload);
      showToast(`${message.payload.room} 방에 연결되었습니다.`);
    }
    if (message.type === "state") handleState(message.payload);
    if (message.type === "goal") handleGoal(message.payload);
    if (message.type === "error") showToast(message.payload?.message || "연결 오류가 발생했습니다.");
  });

  conn.on("close", () => {
    if (allowHostFallback && !joined) {
      fallbackToHost(name, room);
    } else {
      showToast("호스트 연결이 끊겼습니다.");
    }
  });

  conn.on("error", () => {
    if (allowHostFallback && !joined) {
      fallbackToHost(name, room);
    } else {
      showToast("호스트에 연결하지 못했습니다.");
    }
  });
}

function fallbackToHost(name, room) {
  clearTimeout(autoFallbackTimer);
  if (peer && !peer.destroyed) peer.destroy();
  showToast("열린 방이 없어 새 방을 만듭니다.");
  startHost(name, room, true);
}

function startHost(name, room, fromAuto) {
  mode = "host";
  peer = new window.Peer(peerRoomId(room), peerOptions());

  peer.on("open", (id) => {
    hostRoom = makeRoom(room);
    myId = id;
    const player = makePlayer(id, name, "home");
    hostRoom.players.set(id, player);
    handleJoined({ id, room, team: "home" });
    startHostLoop();
    showToast(`${room} 방을 만들었습니다.`);
  });

  peer.on("connection", setupGuestConnection);

  peer.on("error", (error) => {
    if (error?.type === "unavailable-id" || String(error?.message || "").includes("ID")) {
      if (fromAuto) {
        startGuest(name, room, false);
      } else {
        showToast("이미 열린 방입니다. AWAY 또는 자동으로 입장하세요.");
      }
      return;
    }
    showToast("방 생성에 실패했습니다.");
  });
}

function setupGuestConnection(conn) {
  conn.on("data", (message) => {
    if (!hostRoom) return;

    if (message.type === "join") {
      const payload = message.payload || {};
      const existing = hostRoom.players.get(conn.peer);
      if (existing) {
        conn.send({ type: "joined", payload: { id: existing.id, room: hostRoom.code, team: existing.team } });
        return;
      }
      const team = chooseTeam(hostRoom, payload.team === "home" ? "away" : payload.team);
      const player = makePlayer(conn.peer, payload.name || "PLAYER", team);
      hostRoom.players.set(conn.peer, player);
      guestConnections.set(conn.peer, conn);
      conn.send({ type: "joined", payload: { id: player.id, room: hostRoom.code, team: player.team } });
      broadcastState();
    }

    if (message.type === "input") {
      const player = hostRoom.players.get(conn.peer);
      if (player) player.input = normalizeInput(message.payload);
    }
  });

  conn.on("close", () => removeGuest(conn.peer));
  conn.on("error", () => removeGuest(conn.peer));
}

function removeGuest(id) {
  if (!hostRoom) return;
  if (hostRoom.ball.ownerId === id) hostRoom.ball.ownerId = null;
  hostRoom.players.delete(id);
  guestConnections.delete(id);
  broadcastState();
}

function startHostLoop() {
  clearInterval(hostTickTimer);
  clearInterval(hostSnapshotTimer);
  hostTickTimer = setInterval(() => {
    if (!hostRoom) return;
    updateRoom(hostRoom);
  }, 1000 / TICK_RATE);
  hostSnapshotTimer = setInterval(broadcastState, 1000 / SNAPSHOT_RATE);
  broadcastState();
}

function sendInput() {
  if (!myId) return;

  if (mode === "host" && hostRoom) {
    const player = hostRoom.players.get(myId);
    if (player) player.input = normalizeInput(keys);
    return;
  }

  if (mode === "guest" && hostConn?.open) {
    hostConn.send({ type: "input", payload: normalizeInput(keys) });
  }
}

function broadcastState() {
  if (!hostRoom) return;
  const snapshot = roomSnapshot(hostRoom);
  handleState(snapshot);
  for (const conn of guestConnections.values()) {
    if (conn.open) conn.send({ type: "state", payload: snapshot });
  }
}

function broadcastGoal(team) {
  const payload = { team, score: hostRoom.score, pausedUntil: hostRoom.pausedUntil };
  handleGoal(payload);
  for (const conn of guestConnections.values()) {
    if (conn.open) conn.send({ type: "goal", payload });
  }
}

function peerOptions() {
  return {
    debug: 0,
    config: {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    }
  };
}

function peerRoomId(room) {
  return `${PEER_ROOM_PREFIX}-${sanitizeRoomCode(room)}`;
}

function handleJoined(payload) {
  joined = true;
  myId = payload.id;
  myTeam = payload.team;
  joinPanel.classList.add("hidden");
  setRoomCodeLink(payload.room);
  history.replaceState(null, "", publicPathForRoom(payload.room));
}

function handleState(state) {
  previousState = latestState;
  latestState = state;
  updateHud(state);
}

function handleGoal(payload) {
  const label = payload.team === "home" ? "HOME" : "AWAY";
  showToast(`${label} 득점!`);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

async function copyCurrentRoomLink() {
  const room = sanitizeRoomCode(latestState?.code || roomInput.value) || randomNumericCode();
  roomInput.value = room;
  setRoomCodeLink(room);

  const url = inviteUrlFor(room);
  try {
    await navigator.clipboard.writeText(url);
    showToast(`${room} 숫자 링크를 복사했습니다.`);
  } catch {
    showToast(url);
  }
}

function makeRoom(code) {
  return {
    code,
    players: new Map(),
    score: { home: 0, away: 0 },
    ball: makeBall(),
    status: "waiting",
    pausedUntil: 0,
    lastGoalTeam: null,
    clock: MATCH_SECONDS
  };
}

function makeBall() {
  return {
    x: FIELD.width / 2,
    y: FIELD.height / 2,
    vx: 0,
    vy: 0,
    z: 0,
    vz: 0,
    spin: 0,
    ownerId: null,
    lastTouchTeam: null
  };
}

function makePlayer(id, name, team) {
  const spawn = spawnPoint(hostRoom, team);
  return {
    id,
    name: sanitizeName(name),
    team,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    dirX: team === "away" ? -1 : 1,
    dirY: 0,
    stamina: 100,
    sprinting: false,
    input: emptyInput(),
    previousInput: emptyInput(),
    connectedAt: Date.now(),
    lastActionAt: 0,
    runIntentUntil: 0
  };
}

function emptyInput() {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    sprint: false,
    contain: false,
    pass: false,
    through: false,
    lob: false,
    shoot: false,
    modifier: false,
    support: false
  };
}

function normalizeInput(input = {}) {
  return {
    up: Boolean(input.up),
    down: Boolean(input.down),
    left: Boolean(input.left),
    right: Boolean(input.right),
    sprint: Boolean(input.sprint),
    contain: Boolean(input.contain),
    pass: Boolean(input.pass),
    through: Boolean(input.through),
    lob: Boolean(input.lob),
    shoot: Boolean(input.shoot),
    modifier: Boolean(input.modifier),
    support: Boolean(input.support)
  };
}

function sanitizeName(name) {
  return String(name || "PLAYER")
    .replace(/[^\p{L}\p{N}_ -]/gu, "")
    .trim()
    .slice(0, 14) || "PLAYER";
}

function teamCount(room, team) {
  let count = 0;
  for (const player of room.players.values()) {
    if (player.team === team) count += 1;
  }
  return count;
}

function chooseTeam(room, preferredTeam) {
  const preferred = preferredTeam === "away" ? "away" : preferredTeam === "home" ? "home" : null;
  const homeCount = teamCount(room, "home");
  const awayCount = teamCount(room, "away");
  if (preferred && teamCount(room, preferred) < MAX_TEAM_SIZE) return preferred;
  if (awayCount <= homeCount && awayCount < MAX_TEAM_SIZE) return "away";
  if (homeCount < MAX_TEAM_SIZE) return "home";
  return "spectator";
}

function spawnPoint(room, team) {
  const index = teamCount(room, team);
  const offsets = [
    { x: 0, y: 0 },
    { x: -45, y: -96 },
    { x: -45, y: 96 },
    { x: -112, y: -36 },
    { x: -112, y: 36 }
  ];
  const offset = offsets[index % offsets.length];
  if (team === "home") return { x: FIELD.width * 0.28 + offset.x, y: FIELD.height * 0.5 + offset.y };
  if (team === "away") return { x: FIELD.width * 0.72 - offset.x, y: FIELD.height * 0.5 + offset.y };
  return { x: FIELD.width / 2, y: FIELD.height - 50 };
}

function resetForKickoff(room, scoringTeam = null) {
  room.ball = makeBall();
  room.ball.lastTouchTeam = scoringTeam;
  for (const player of room.players.values()) {
    if (player.team === "spectator") continue;
    const spawn = spawnPointForKickoff(player.team, player.id, room);
    player.x = spawn.x;
    player.y = spawn.y;
    player.vx = 0;
    player.vy = 0;
    player.dirX = player.team === "away" ? -1 : 1;
    player.dirY = 0;
  }
}

function spawnPointForKickoff(team, playerId, room) {
  const teammates = [...room.players.values()]
    .filter((player) => player.team === team)
    .sort((a, b) => a.connectedAt - b.connectedAt);
  const index = Math.max(0, teammates.findIndex((player) => player.id === playerId));
  const lanes = [-110, 110, -205, 205, 0];
  const y = FIELD.height / 2 + lanes[index % lanes.length];
  const x = team === "home" ? FIELD.width * (index === 0 ? 0.39 : 0.31) : FIELD.width * (index === 0 ? 0.61 : 0.69);
  return { x, y: clamp(y, 90, FIELD.height - 90) };
}

function updateRoom(room) {
  const now = Date.now();
  const activeTeams = new Set(
    [...room.players.values()]
      .filter((player) => player.team !== "spectator")
      .map((player) => player.team)
  );

  if (activeTeams.has("home") && activeTeams.has("away")) {
    if (room.status === "waiting") {
      room.status = "playing";
      room.clock = MATCH_SECONDS;
      resetForKickoff(room);
    }
  } else {
    room.status = "waiting";
    room.ball.ownerId = null;
  }

  if (room.status !== "playing" || now < room.pausedUntil) return;

  room.clock = Math.max(0, room.clock - DT);
  if (room.clock <= 0) {
    room.status = "finished";
    room.pausedUntil = now + 7000;
    return;
  }

  for (const player of room.players.values()) {
    if (player.team !== "spectator") updatePlayer(room, player);
  }

  resolvePlayerCollisions(room);
  updateBall(room);
  resolveBallPossession(room);
  checkGoal(room);
}

function inputPressed(player, key) {
  return player.input[key] && !player.previousInput[key];
}

function updatePlayer(room, player) {
  const input = player.input;
  const moveX = Number(input.right) - Number(input.left);
  const moveY = Number(input.down) - Number(input.up);
  const move = normalize(moveX, moveY);
  const hasBall = room.ball.ownerId === player.id;
  const closeControl = input.contain;
  const sprintRequested = input.sprint && player.stamina > 4 && !closeControl;
  const baseSpeed = hasBall ? 218 : 238;
  const sprintBonus = sprintRequested ? 92 : 0;
  const controlPenalty = closeControl ? 0.66 : 1;
  const maxSpeed = (baseSpeed + sprintBonus) * controlPenalty;
  const acceleration = hasBall ? 1450 : 1660;
  const friction = move.x || move.y ? 0.82 : 0.72;

  if (move.x || move.y) {
    player.dirX = move.x;
    player.dirY = move.y;
    player.vx += move.x * acceleration * DT;
    player.vy += move.y * acceleration * DT;
  }

  const speed = Math.hypot(player.vx, player.vy);
  if (speed > maxSpeed) {
    player.vx = (player.vx / speed) * maxSpeed;
    player.vy = (player.vy / speed) * maxSpeed;
  }

  player.x += player.vx * DT;
  player.y += player.vy * DT;
  player.vx *= friction;
  player.vy *= friction;
  player.x = clamp(player.x, FIELD.playerRadius, FIELD.width - FIELD.playerRadius);
  player.y = clamp(player.y, FIELD.playerRadius, FIELD.height - FIELD.playerRadius);
  player.sprinting = sprintRequested;

  if (sprintRequested && (move.x || move.y)) {
    player.stamina = clamp(player.stamina - 26 * DT, 0, 100);
  } else {
    player.stamina = clamp(player.stamina + 15 * DT, 0, 100);
  }

  if (inputPressed(player, "support")) player.runIntentUntil = Date.now() + 1600;
  if (inputPressed(player, "pass")) doPass(room, player, "short");
  if (inputPressed(player, "through")) doPass(room, player, "through");
  if (inputPressed(player, "lob")) doPass(room, player, "lob");
  if (inputPressed(player, "shoot")) doShootOrTackle(room, player);
  player.previousInput = { ...player.input };
}

function resolvePlayerCollisions(room) {
  const players = [...room.players.values()].filter((player) => player.team !== "spectator");
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i];
      const b = players[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const minDistance = FIELD.playerRadius * 2;
      if (d >= minDistance) continue;
      const overlap = (minDistance - d) / 2;
      const nx = dx / d;
      const ny = dy / d;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;
      a.vx -= nx * 22;
      a.vy -= ny * 22;
      b.vx += nx * 22;
      b.vy += ny * 22;
    }
  }
}

function aimDirection(player) {
  const input = player.input;
  const raw = normalize(Number(input.right) - Number(input.left), Number(input.down) - Number(input.up));
  if (raw.x || raw.y) return raw;
  return normalize(player.dirX || (player.team === "away" ? -1 : 1), player.dirY || 0);
}

function teammateTarget(room, player, lead = 0) {
  const aim = aimDirection(player);
  const teammates = [...room.players.values()].filter((candidate) => candidate.team === player.team && candidate.id !== player.id);
  let best = null;
  let bestScore = -Infinity;
  for (const mate of teammates) {
    const toMate = normalize(mate.x - player.x, mate.y - player.y);
    const dot = toMate.x * aim.x + toMate.y * aim.y;
    const d = distance(player, mate);
    const supportBoost = Date.now() < mate.runIntentUntil ? 0.28 : 0;
    const score = dot * 2 - d / 950 + supportBoost;
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  if (!best || bestScore < -0.15) return { x: player.x + aim.x * (lead || 260), y: player.y + aim.y * (lead || 260) };
  return { x: clamp(best.x + aim.x * lead, 35, FIELD.width - 35), y: clamp(best.y + aim.y * lead, 35, FIELD.height - 35) };
}

function doPass(room, player, kind) {
  const ball = room.ball;
  if (ball.ownerId !== player.id) {
    if (kind === "lob") attemptSlide(room, player);
    else attemptTackle(room, player, kind === "short" ? 0.78 : 0.58);
    return;
  }

  const aim = aimDirection(player);
  const target = teammateTarget(room, player, kind === "through" ? 135 : 0);
  const toTarget = normalize(target.x - player.x, target.y - player.y);
  const dir = toTarget.x || toTarget.y ? toTarget : aim;
  const speed = kind === "short" ? 450 : kind === "through" ? 650 : 570;
  ball.ownerId = null;
  ball.vx = dir.x * speed + player.vx * 0.16;
  ball.vy = dir.y * speed + player.vy * 0.16;
  ball.x = player.x + dir.x * 27;
  ball.y = player.y + dir.y * 27;
  ball.z = Math.max(ball.z, 0);
  ball.vz = kind === "lob" ? 360 : 0;
  ball.spin = kind === "lob" ? 0 : aim.y * 42;
  ball.lastTouchTeam = player.team;
  player.lastActionAt = Date.now();
}

function doShootOrTackle(room, player) {
  const ball = room.ball;
  if (ball.ownerId !== player.id) {
    attemptTackle(room, player, 0.7);
    return;
  }

  const aim = aimDirection(player);
  const attackingRight = player.team === "home";
  const goalX = attackingRight ? FIELD.width + FIELD.goalDepth : -FIELD.goalDepth;
  const goalY = FIELD.height / 2;
  const goalVector = normalize(goalX - player.x, goalY - player.y);
  const dir = normalize(goalVector.x * 0.72 + aim.x * 0.38, goalVector.y * 0.72 + aim.y * 0.38);
  const finesse = player.input.modifier;
  const power = player.input.sprint ? 890 : 790;

  ball.ownerId = null;
  ball.x = player.x + dir.x * 29;
  ball.y = player.y + dir.y * 29;
  ball.vx = dir.x * power + player.vx * 0.22;
  ball.vy = dir.y * power + player.vy * 0.22;
  ball.z = 0;
  ball.vz = finesse ? 120 : 72;
  ball.spin = finesse ? (attackingRight ? 1 : -1) * (aim.y || (player.y > goalY ? -1 : 1)) * 180 : 0;
  ball.lastTouchTeam = player.team;
  player.lastActionAt = Date.now();
}

function attemptTackle(room, player, strength) {
  const ball = room.ball;
  const owner = ball.ownerId ? room.players.get(ball.ownerId) : null;
  const aim = aimDirection(player);
  if (owner && owner.team !== player.team) {
    const dx = owner.x - player.x;
    const dy = owner.y - player.y;
    const d = Math.hypot(dx, dy);
    const facing = normalize(dx, dy);
    const alignment = facing.x * aim.x + facing.y * aim.y;
    if (d < 46 && alignment > -0.25) {
      const stealChance = strength + (player.input.contain ? 0.16 : 0) - (owner.input.contain ? 0.13 : 0);
      if (stealChance > 0.62 || d < 30) {
        ball.ownerId = player.id;
        ball.lastTouchTeam = player.team;
      } else {
        owner.vx += facing.x * 130;
        owner.vy += facing.y * 130;
      }
    }
    return;
  }
  if (distance(player, ball) < 44 && ball.z < 14) {
    ball.ownerId = player.id;
    ball.lastTouchTeam = player.team;
  }
}

function attemptSlide(room, player) {
  const aim = aimDirection(player);
  player.vx += aim.x * 360;
  player.vy += aim.y * 360;
  attemptTackle(room, player, 0.82);
}

function updateBall(room) {
  const ball = room.ball;
  const owner = ball.ownerId ? room.players.get(ball.ownerId) : null;
  if (owner) {
    const dir = normalize(owner.dirX || (owner.team === "away" ? -1 : 1), owner.dirY || 0);
    const closeControl = owner.input.contain;
    const lead = closeControl ? 22 : owner.sprinting ? 34 : 28;
    ball.x += (owner.x + dir.x * lead - ball.x) * (closeControl ? 0.72 : 0.58);
    ball.y += (owner.y + dir.y * lead - ball.y) * (closeControl ? 0.72 : 0.58);
    ball.vx = owner.vx;
    ball.vy = owner.vy;
    ball.z = 0;
    ball.vz = 0;
    ball.spin *= 0.8;
    ball.lastTouchTeam = owner.team;
    return;
  }

  ball.vx += ball.spin * DT * 0.16;
  ball.x += ball.vx * DT;
  ball.y += ball.vy * DT;
  ball.z += ball.vz * DT;
  ball.vz -= 760 * DT;
  if (ball.z < 0) {
    ball.z = 0;
    ball.vz *= -0.36;
    ball.vx *= 0.88;
    ball.vy *= 0.88;
    if (Math.abs(ball.vz) < 42) ball.vz = 0;
  }

  const groundDrag = ball.z > 0 ? 0.994 : 0.982;
  ball.vx *= groundDrag;
  ball.vy *= groundDrag;
  ball.spin *= 0.985;

  const goalTop = FIELD.height / 2 - FIELD.goalWidth / 2;
  const goalBottom = FIELD.height / 2 + FIELD.goalWidth / 2;
  const inGoalMouth = ball.y > goalTop && ball.y < goalBottom;
  if (!inGoalMouth) {
    if (ball.x < FIELD.ballRadius) {
      ball.x = FIELD.ballRadius;
      ball.vx = Math.abs(ball.vx) * 0.66;
    }
    if (ball.x > FIELD.width - FIELD.ballRadius) {
      ball.x = FIELD.width - FIELD.ballRadius;
      ball.vx = -Math.abs(ball.vx) * 0.66;
    }
  }
  if (ball.y < FIELD.ballRadius) {
    ball.y = FIELD.ballRadius;
    ball.vy = Math.abs(ball.vy) * 0.72;
  }
  if (ball.y > FIELD.height - FIELD.ballRadius) {
    ball.y = FIELD.height - FIELD.ballRadius;
    ball.vy = -Math.abs(ball.vy) * 0.72;
  }
}

function resolveBallPossession(room) {
  const ball = room.ball;
  if (ball.ownerId || ball.z > 22) return;
  let best = null;
  let bestDistance = Infinity;
  for (const player of room.players.values()) {
    if (player.team === "spectator") continue;
    const d = distance(player, ball);
    if (d < bestDistance) {
      best = player;
      bestDistance = d;
    }
  }
  const ballSpeed = Math.hypot(ball.vx, ball.vy);
  if (best && bestDistance < (ballSpeed > 520 ? 26 : 34)) {
    ball.ownerId = best.id;
    ball.lastTouchTeam = best.team;
    ball.vx *= 0.2;
    ball.vy *= 0.2;
  }
}

function checkGoal(room) {
  const ball = room.ball;
  const goalTop = FIELD.height / 2 - FIELD.goalWidth / 2;
  const goalBottom = FIELD.height / 2 + FIELD.goalWidth / 2;
  if (ball.y < goalTop || ball.y > goalBottom || ball.z > 90) return;
  if (ball.x < -FIELD.goalDepth / 2) {
    room.score.away += 1;
    afterGoal(room, "away");
  }
  if (ball.x > FIELD.width + FIELD.goalDepth / 2) {
    room.score.home += 1;
    afterGoal(room, "home");
  }
}

function afterGoal(room, team) {
  room.lastGoalTeam = team;
  room.pausedUntil = Date.now() + 2400;
  resetForKickoff(room, team);
  broadcastGoal(team);
}

function roomSnapshot(room) {
  return {
    code: room.code,
    field: FIELD,
    status: room.status,
    score: room.score,
    clock: Math.ceil(room.clock),
    lastGoalTeam: room.lastGoalTeam,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      team: player.team,
      x: Math.round(player.x * 10) / 10,
      y: Math.round(player.y * 10) / 10,
      dirX: Math.round(player.dirX * 100) / 100,
      dirY: Math.round(player.dirY * 100) / 100,
      stamina: Math.round(player.stamina),
      sprinting: player.sprinting,
      hasBall: room.ball.ownerId === player.id,
      runIntent: Date.now() < player.runIntentUntil
    })),
    ball: {
      x: Math.round(room.ball.x * 10) / 10,
      y: Math.round(room.ball.y * 10) / 10,
      z: Math.round(room.ball.z * 10) / 10,
      ownerId: room.ball.ownerId
    }
  };
}

function updateHud(state) {
  homeScore.textContent = state.score.home;
  awayScore.textContent = state.score.away;
  clockEl.textContent = formatClock(state.clock);
  setRoomCodeLink(state.code);
  statusText.textContent = statusLabel(state);
  renderPlayers(state);
}

function roomCodeFromUrl() {
  const queryRoom = sanitizeRoomCode(urlParams.get("room"));
  if (queryRoom) return queryRoom;

  const parts = decodeURIComponent(location.pathname).split("/").filter(Boolean);
  const last = parts.at(-1) || "";
  if (/^\d{4,18}$/.test(last)) return last;
  return "";
}

function sanitizeRoomCode(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 18)
    .toUpperCase();
}

function randomNumericCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
}

function appBasePath() {
  const modulePath = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  if (!modulePath || modulePath === "/") return "";
  return modulePath;
}

function inviteUrlFor(room) {
  if (location.protocol === "file:") return publicPathForRoom(room);
  return new URL(publicPathForRoom(room), location.origin).toString();
}

function publicPathForRoom(room) {
  const code = sanitizeRoomCode(room);
  const base = appBasePath();
  if (/^\d{4,18}$/.test(code)) return `${base}/${code}`.replace(/\/{2,}/g, "/");
  return `${base || "/" }?room=${encodeURIComponent(code || "MAIN")}`;
}

function setRoomCodeLink(room) {
  const code = sanitizeRoomCode(room) || "MAIN";
  roomCodeEl.textContent = code;
  roomCodeEl.href = publicPathForRoom(code);
}

function formatClock(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.max(0, totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function statusLabel(state) {
  if (mode === "guest" && !joined) return "연결 중";
  if (state.status === "waiting") return state.players.length < 2 ? "상대 대기" : "대기 중";
  if (state.status === "finished") return "경기 종료";
  return "LIVE";
}

function renderPlayers(state) {
  playersEl.replaceChildren();
  const sorted = [...state.players].sort((a, b) => {
    const teamOrder = { home: 0, away: 1, spectator: 2 };
    return teamOrder[a.team] - teamOrder[b.team] || a.name.localeCompare(b.name);
  });
  for (const player of sorted) {
    const row = document.createElement("div");
    row.className = "player-row";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = player.team === "home" ? "#ff4d5f" : player.team === "away" ? "#4fb3ff" : "#a9beb6";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${player.name}${player.id === myId ? " (나)" : ""}`;

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = player.team === "spectator" ? "관전" : player.team.toUpperCase();

    row.append(dot, name, tag);
    playersEl.append(row);
  }
}

function render(time) {
  const dt = Math.min(0.05, (time - lastRenderTime) / 1000);
  lastRenderTime = time;

  if (!latestState) {
    drawLoading();
    requestAnimationFrame(render);
    return;
  }

  const state = interpolateState(previousState, latestState, 0.55);
  setupCamera(state, dt);
  drawScene(state);
  requestAnimationFrame(render);
}

function interpolateState(prev, next, alpha) {
  if (!prev || prev.code !== next.code) return next;
  const previousPlayers = new Map(prev.players.map((player) => [player.id, player]));
  return {
    ...next,
    ball: lerpBody(prev.ball, next.ball, alpha),
    players: next.players.map((player) => {
      const previous = previousPlayers.get(player.id);
      if (!previous) return player;
      return { ...player, x: lerp(previous.x, player.x, alpha), y: lerp(previous.y, player.y, alpha) };
    })
  };
}

function lerpBody(a, b, alpha) {
  return { ...b, x: lerp(a.x, b.x, alpha), y: lerp(a.y, b.y, alpha), z: lerp(a.z || 0, b.z || 0, alpha) };
}

function lerp(a, b, alpha) {
  return a + (b - a) * alpha;
}

function setupCamera(state, dt) {
  const field = state.field;
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const scale = Math.min(viewW / (field.width + 170), viewH / (field.height + 130));
  camera.scale = Math.max(0.62, Math.min(1.22, scale));

  const me = state.players.find((player) => player.id === myId);
  const focus = me || state.ball;
  const targetX = viewW / 2 - focus.x * camera.scale;
  const targetY = viewH / 2 - focus.y * camera.scale;
  const minX = viewW - field.width * camera.scale - 42;
  const minY = viewH - field.height * camera.scale - 42;
  const maxX = 42;
  const maxY = 70;
  const desiredX = clamp(targetX, Math.min(minX, maxX), maxX);
  const desiredY = clamp(targetY, Math.min(minY, maxY), maxY);
  const smoothing = 1 - Math.pow(0.001, dt);
  camera.x += (desiredX - camera.x) * smoothing;
  camera.y += (desiredY - camera.y) * smoothing;
}

function worldToScreen(x, y) {
  return { x: camera.x + x * camera.scale, y: camera.y + y * camera.scale };
}

function drawScene(state) {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawBackdrop();
  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.scale, camera.scale);
  drawPitch(state.field);
  drawGoalFrames(state.field);

  const players = [...state.players]
    .filter((player) => player.team !== "spectator")
    .sort((a, b) => a.y - b.y);
  for (const player of players) drawPlayer(player, state);
  drawBall(state.ball, state.field);
  drawPossessionCue(state);
  ctx.restore();
  drawMobileHint();
}

function drawBackdrop() {
  const gradient = ctx.createLinearGradient(0, 0, 0, window.innerHeight);
  gradient.addColorStop(0, "#06100e");
  gradient.addColorStop(1, "#0b1814");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
}

function drawPitch(field) {
  const stripeCount = 12;
  for (let i = 0; i < stripeCount; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? "#28784c" : "#246f46";
    ctx.fillRect((field.width / stripeCount) * i, 0, field.width / stripeCount + 1, field.height);
  }

  ctx.save();
  ctx.globalAlpha = 0.17;
  ctx.strokeStyle = "#d9fff0";
  for (let y = 24; y < field.height; y += 42) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(field.width, y + 18);
    ctx.stroke();
  }
  ctx.restore();

  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(235, 255, 245, 0.86)";
  ctx.strokeRect(0, 0, field.width, field.height);
  line(field.width / 2, 0, field.width / 2, field.height);
  circle(field.width / 2, field.height / 2, 94);
  circle(field.width / 2, field.height / 2, 4, true);
  drawPenaltyBox(0, field.height / 2, 1);
  drawPenaltyBox(field.width, field.height / 2, -1);

  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.fillRect(-field.goalDepth, field.height / 2 - field.goalWidth / 2, field.goalDepth, field.goalWidth);
  ctx.fillRect(field.width, field.height / 2 - field.goalWidth / 2, field.goalDepth, field.goalWidth);
}

function drawPenaltyBox(x, centerY, dir) {
  const boxW = 178;
  const boxH = 430;
  const smallW = 72;
  const smallH = 240;
  const startX = dir > 0 ? x : x - boxW;
  const smallX = dir > 0 ? x : x - smallW;
  ctx.strokeRect(startX, centerY - boxH / 2, boxW, boxH);
  ctx.strokeRect(smallX, centerY - smallH / 2, smallW, smallH);
  circle(x + dir * 126, centerY, 4, true);
  ctx.beginPath();
  ctx.arc(x + dir * 126, centerY, 84, -0.9, 0.9, dir < 0);
  ctx.stroke();
}

function drawGoalFrames(field) {
  drawGoal(-field.goalDepth, field.height / 2 - field.goalWidth / 2, field.goalDepth, field.goalWidth, "#ff4d5f");
  drawGoal(field.width, field.height / 2 - field.goalWidth / 2, field.goalDepth, field.goalWidth, "#4fb3ff");
}

function drawGoal(x, y, w, h, color) {
  ctx.save();
  ctx.fillStyle = "rgba(6, 13, 14, 0.34)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.strokeRect(x, y, w, h);
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  for (let i = 10; i < h; i += 18) line(x, y + i, x + w, y + i);
  for (let i = 8; i < w; i += 18) line(x + i, y, x + i, y + h);
  ctx.restore();
}

function drawPlayer(player, state) {
  const color = player.team === "home" ? "#ff4d5f" : "#4fb3ff";
  const accent = player.team === "home" ? "#ffd0d6" : "#d7efff";
  const radius = state.field.playerRadius;

  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
  ctx.beginPath();
  ctx.ellipse(2, 13, radius * 1.05, radius * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();

  if (player.id === myId) {
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, radius + 8, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (player.runIntent) {
    ctx.strokeStyle = "rgba(255, 209, 102, 0.72)";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.arc(0, 0, radius + 14, -Math.PI / 2, Math.PI * 1.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.78)";
  ctx.stroke();

  const dir = normalize(player.dirX || 1, player.dirY || 0);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(dir.x * 8, dir.y * 8, 4.5, 0, Math.PI * 2);
  ctx.fill();

  drawStamina(player, radius);
  drawNameplate(player, radius);

  if (player.hasBall) {
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, radius + 4, -Math.PI / 2, Math.PI * 1.5);
    ctx.stroke();
  }

  ctx.restore();
}

function drawStamina(player, radius) {
  ctx.strokeStyle = "rgba(8, 13, 14, 0.58)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, 0, radius + 5, Math.PI * 0.78, Math.PI * 2.22);
  ctx.stroke();

  ctx.strokeStyle = player.stamina > 28 ? "#81f5a6" : "#ffcf66";
  ctx.beginPath();
  ctx.arc(0, 0, radius + 5, Math.PI * 0.78, Math.PI * (0.78 + 1.44 * (player.stamina / 100)));
  ctx.stroke();
}

function drawNameplate(player, radius) {
  ctx.font = "700 13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const text = player.name;
  const width = Math.min(120, Math.max(42, ctx.measureText(text).width + 18));
  const y = -radius - 22;
  ctx.fillStyle = "rgba(4, 11, 11, 0.64)";
  roundedRect(-width / 2, y - 11, width, 22, 5);
  ctx.fill();
  ctx.fillStyle = "#eef6f2";
  ctx.fillText(text, 0, y);
}

function drawBall(ball, field) {
  const radius = field.ballRadius;
  const z = ball.z || 0;
  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.fillStyle = `rgba(0, 0, 0, ${z > 0 ? 0.18 : 0.35})`;
  ctx.beginPath();
  ctx.ellipse(2, 8 + z * 0.08, radius * 1.3, radius * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(0, -z * 0.42);
  const gradient = ctx.createRadialGradient(-3, -4, 2, 0, 0, radius + 3);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(0.7, "#e8f0ef");
  gradient.addColorStop(1, "#bac5c3");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(11, 19, 18, 0.72)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  line(-radius * 0.8, 0, radius * 0.8, 0);
  line(0, -radius * 0.8, 0, radius * 0.8);
  ctx.restore();
}

function drawPossessionCue(state) {
  const me = state.players.find((player) => player.id === myId);
  if (!me) return;
  const ball = state.ball;
  const screen = worldToScreen(ball.x, ball.y);
  if (screen.x > -20 && screen.x < window.innerWidth + 20 && screen.y > -20 && screen.y < window.innerHeight + 20) return;

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  const angle = Math.atan2(screen.y - centerY, screen.x - centerX);
  const x = centerX + Math.cos(angle) * Math.min(window.innerWidth * 0.42, 260);
  const y = centerY + Math.sin(angle) * Math.min(window.innerHeight * 0.38, 190);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = "rgba(255, 209, 102, 0.92)";
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-10, -9);
  ctx.lineTo(-10, 9);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawMobileHint() {
  if (window.innerWidth > 760 || myId) return;
  ctx.save();
  ctx.fillStyle = "rgba(238, 246, 242, 0.74)";
  ctx.font = "700 13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("키보드 플레이에 맞춰진 PVP입니다.", window.innerWidth / 2, window.innerHeight - 24);
  ctx.restore();
}

function drawLoading() {
  drawBackdrop();
  ctx.fillStyle = "#eef6f2";
  ctx.font = "800 18px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("경기장 준비 중", window.innerWidth / 2, window.innerHeight / 2);
}

function line(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function circle(x, y, radius, fill = false) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  if (fill) ctx.fill();
  else ctx.stroke();
}

function roundedRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function normalize(x, y) {
  const length = Math.hypot(x, y);
  if (length < 0.001) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
