const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8767);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const STATE_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'state.json') : path.join(ROOT, 'data', 'state.json');
const DB_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'ryder.sqlite') : path.join(ROOT, 'data', 'ryder.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const db = openDatabase();
let sharedState;
sharedState = loadState();
const clients = new Set();

function defaultPairs() {
  return Array.from({ length: 14 }, (_, index) => {
    const number = index + 1;
    return {
      id: number,
      tigers: `Tigers Pareja #${number}`,
      firmas: `Firmas Pareja #${number}`
    };
  });
}

function defaultIndividuals() {
  return Array.from({ length: 28 }, (_, index) => {
    const number = index + 1;
    return {
      id: number,
      tigers: `Jugador Tigers #${number}`,
      firmas: `Jugador Firmas #${number}`
    };
  });
}

function tournamentMatches() {
  const pairs = defaultPairs();
  const individuals = defaultIndividuals();
  return [
    ...pairs.map(pair => ({
      id: `scramble-${String(pair.id).padStart(2, '0')}`,
      type: 'Scramble',
      title: `Scramble #${pair.id}`,
      pairId: pair.id,
      holes: 9
    })),
    ...pairs.map(pair => ({
      id: `golpe-${String(pair.id).padStart(2, '0')}`,
      type: 'Golpe a Golpe',
      title: `Golpe a Golpe #${pair.id}`,
      pairId: pair.id,
      holes: 9
    })),
    ...individuals.map(individual => ({
      id: `individual-${String(individual.id).padStart(2, '0')}`,
      type: 'Individual',
      title: `Individual #${individual.id}`,
      individualId: individual.id,
      holes: 18
    }))
  ];
}

function emptyPairs() {
  return defaultPairs().map(pair => ({ id: pair.id, tigers: '', firmas: '' }));
}

function emptyIndividuals() {
  return defaultIndividuals().map(individual => ({ id: individual.id, tigers: '', firmas: '' }));
}

function openDatabase() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      team TEXT NOT NULL,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS system_users (
      username TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      access TEXT
    );
    CREATE TABLE IF NOT EXISTS pairs (
      id INTEGER PRIMARY KEY,
      tigers_player_1_id INTEGER,
      tigers_player_2_id INTEGER,
      firmas_player_1_id INTEGER,
      firmas_player_2_id INTEGER,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (tigers_player_1_id) REFERENCES players(id),
      FOREIGN KEY (tigers_player_2_id) REFERENCES players(id),
      FOREIGN KEY (firmas_player_1_id) REFERENCES players(id),
      FOREIGN KEY (firmas_player_2_id) REFERENCES players(id)
    );
    CREATE TABLE IF NOT EXISTS individuals (
      id INTEGER PRIMARY KEY,
      tigers_player_id INTEGER,
      firmas_player_id INTEGER,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (tigers_player_id) REFERENCES players(id),
      FOREIGN KEY (firmas_player_id) REFERENCES players(id)
    );
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      pair_id INTEGER,
      individual_id INTEGER,
      holes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hole_scores (
      match_id TEXT NOT NULL,
      team TEXT NOT NULL CHECK (team IN ('tigers', 'firmas')),
      hole_index INTEGER NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (match_id, team, hole_index),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS finalizations (
      match_id TEXT PRIMARY KEY,
      finalized INTEGER NOT NULL DEFAULT 1,
      result TEXT,
      finalized_at TEXT,
      finalized_by TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE TABLE IF NOT EXISTS signatures (
      match_id TEXT NOT NULL,
      team TEXT NOT NULL CHECK (team IN ('tigers', 'firmas')),
      data_url TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (match_id, team),
      FOREIGN KEY (match_id) REFERENCES finalizations(match_id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      match_id TEXT,
      username TEXT,
      payload TEXT,
      created_at TEXT NOT NULL
    );
  `);
  seedMatches(database);
  return database;
}

function seedMatches(database = db) {
  const insert = database.prepare(`
    INSERT INTO matches (id, type, title, pair_id, individual_id, holes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      pair_id = excluded.pair_id,
      individual_id = excluded.individual_id,
      holes = excluded.holes
  `);
  tournamentMatches().forEach(match => {
    insert.run(
      match.id,
      match.type,
      match.title,
      match.pairId || null,
      match.individualId || null,
      match.holes
    );
  });
}

function loadJsonState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return data?.values ? { values: data.values } : { values: data || {} };
  } catch {
    return { values: {} };
  }
}

function loadState() {
  try {
    const fromDb = composeStateFromDb();
    if (hasMeaningfulSqlState(fromDb.values)) return fromDb;

    const row = db.prepare('SELECT json FROM app_state WHERE id = 1').get();
    if (row?.json) {
      const legacyState = JSON.parse(row.json);
      saveSharedState(legacyState);
      return composeStateFromDb();
    }
  } catch (error) {
    console.warn('No fue posible cargar SQLite, usando JSON', error);
  }

  const jsonState = loadJsonState();
  saveSharedState(jsonState);
  return composeStateFromDb();
}

function normalizeName(value) {
  return String(value || '').trim().toLocaleLowerCase('es-CO');
}

function splitSelection(value) {
  return String(value || '').split('&').map(item => item.trim()).filter(Boolean);
}

function isPlaceholder(value) {
  const text = normalizeName(value);
  return !text || text.includes('pareja #') || text.includes('jugador tigers #') || text.includes('jugador firmas #');
}

function playerLabel(player) {
  return player?.name || '';
}

function playerIdsForSelection(playersByNameAndTeam, team, value, expected) {
  if (isPlaceholder(value)) return Array(expected).fill(null);
  const names = splitSelection(value).slice(0, expected);
  while (names.length < expected) names.push('');
  return names.map(name => playersByNameAndTeam.get(`${team}:${normalizeName(name)}`)?.id || null);
}

function composePlayerMaps(players) {
  const byId = new Map();
  const byNameAndTeam = new Map();
  players.forEach(player => {
    byId.set(Number(player.id), player);
    byNameAndTeam.set(`${player.team}:${normalizeName(player.name)}`, player);
  });
  return { byId, byNameAndTeam };
}

function loadPlayersFromDb() {
  return db.prepare(`
    SELECT id, team, name, username, password, is_admin AS isAdmin
    FROM players
    ORDER BY id
  `).all().map(player => ({
    ...player,
    isAdmin: Boolean(player.isAdmin)
  }));
}

function loadSystemUsersFromDb() {
  return db.prepare(`
    SELECT username, name, password, is_admin AS isAdmin, access
    FROM system_users
    ORDER BY username
  `).all().map(user => ({
    ...user,
    isAdmin: Boolean(user.isAdmin)
  }));
}

function configuredPairCount() {
  return db.prepare(`
    SELECT COUNT(*) AS total
    FROM pairs
    WHERE tigers_player_1_id IS NOT NULL
       OR tigers_player_2_id IS NOT NULL
       OR firmas_player_1_id IS NOT NULL
       OR firmas_player_2_id IS NOT NULL
  `).get().total;
}

function configuredIndividualCount() {
  return db.prepare(`
    SELECT COUNT(*) AS total
    FROM individuals
    WHERE tigers_player_id IS NOT NULL
       OR firmas_player_id IS NOT NULL
  `).get().total;
}

function composePairsFromDb(playersById) {
  const defaults = defaultPairs();
  const rows = db.prepare('SELECT * FROM pairs ORDER BY id').all();
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  return defaults.map(item => {
    const row = byId.get(item.id);
    if (!row) return { id: item.id, tigers: '', firmas: '' };
    const tigers = [row.tigers_player_1_id, row.tigers_player_2_id].map(id => playerLabel(playersById.get(Number(id)))).filter(Boolean).join(' & ');
    const firmas = [row.firmas_player_1_id, row.firmas_player_2_id].map(id => playerLabel(playersById.get(Number(id)))).filter(Boolean).join(' & ');
    return {
      id: item.id,
      tigers: tigers || '',
      firmas: firmas || ''
    };
  });
}

function composeIndividualsFromDb(playersById) {
  const defaults = defaultIndividuals();
  const rows = db.prepare('SELECT * FROM individuals ORDER BY id').all();
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  return defaults.map(item => {
    const row = byId.get(item.id);
    if (!row) return { id: item.id, tigers: '', firmas: '' };
    return {
      id: item.id,
      tigers: playerLabel(playersById.get(Number(row.tigers_player_id))) || '',
      firmas: playerLabel(playersById.get(Number(row.firmas_player_id))) || ''
    };
  });
}

function composeScoresFromDb() {
  const values = {};
  tournamentMatches().forEach(match => {
    values[match.id] = {
      tigers: Array(match.holes).fill(''),
      firmas: Array(match.holes).fill('')
    };
  });
  db.prepare('SELECT match_id, team, hole_index, value FROM hole_scores ORDER BY match_id, team, hole_index').all().forEach(row => {
    if (!values[row.match_id]?.[row.team]) return;
    if (row.hole_index >= 0 && row.hole_index < values[row.match_id][row.team].length) {
      values[row.match_id][row.team][row.hole_index] = row.value;
    }
  });
  return values;
}

function composeFinalizationsFromDb() {
  const finalizations = {};
  const rows = db.prepare('SELECT * FROM finalizations WHERE finalized = 1 ORDER BY match_id').all();
  const signatures = db.prepare('SELECT match_id, team, data_url FROM signatures ORDER BY match_id, team').all();
  const signaturesByMatch = new Map();
  signatures.forEach(signature => {
    if (!signaturesByMatch.has(signature.match_id)) signaturesByMatch.set(signature.match_id, {});
    signaturesByMatch.get(signature.match_id)[signature.team] = signature.data_url;
  });
  rows.forEach(row => {
    finalizations[row.match_id] = {
      finalized: true,
      result: row.result || '',
      signatures: signaturesByMatch.get(row.match_id) || {},
      finalizedAt: row.finalized_at || '',
      finalizedBy: row.finalized_by || ''
    };
  });
  return finalizations;
}

function composeStateFromDb() {
  const players = loadPlayersFromDb();
  const systemUsers = loadSystemUsersFromDb();
  const { byId } = composePlayerMaps(players);
  return {
    values: {
      values: composeScoresFromDb(),
      finalizations: composeFinalizationsFromDb(),
      players,
      systemUsers,
      pairs: composePairsFromDb(byId),
      individuals: composeIndividualsFromDb(byId)
    }
  };
}

function hasMeaningfulSqlState(values = {}) {
  return (
    (Array.isArray(values.players) && values.players.length > 0) ||
    (Array.isArray(values.systemUsers) && values.systemUsers.length > 0) ||
    configuredPairCount() > 0 ||
    configuredIndividualCount() > 0 ||
    db.prepare('SELECT COUNT(*) AS total FROM hole_scores').get().total > 0 ||
    db.prepare('SELECT COUNT(*) AS total FROM finalizations WHERE finalized = 1').get().total > 0
  );
}

function audit(action, payload = {}, matchId = null, username = null) {
  db.prepare(`
    INSERT INTO audit_log (action, match_id, username, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(action, matchId, username, JSON.stringify(payload || {}), new Date().toISOString());
}

function messageUsername(message) {
  return String(message?.username || message?.finalization?.finalizedBy || '').trim();
}

function syncRelationalTables(state) {
  const values = state.values || {};
  const players = Array.isArray(values.players) ? values.players : [];
  const systemUsers = Array.isArray(values.systemUsers) ? values.systemUsers : [];
  const pairs = Array.isArray(values.pairs) ? values.pairs : [];
  const individuals = Array.isArray(values.individuals) ? values.individuals : [];
  const scores = values.values || {};
  const finalizations = values.finalizations || {};
  const now = new Date().toISOString();
  const insertPlayer = db.prepare(`
    INSERT INTO players (id, team, name, username, password, is_admin)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertSystemUser = db.prepare(`
    INSERT INTO system_users (username, name, password, is_admin, access)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertPair = db.prepare(`
    INSERT INTO pairs (id, tigers_player_1_id, tigers_player_2_id, firmas_player_1_id, firmas_player_2_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertIndividual = db.prepare(`
    INSERT INTO individuals (id, tigers_player_id, firmas_player_id, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertScore = db.prepare(`
    INSERT INTO hole_scores (match_id, team, hole_index, value, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertFinalization = db.prepare(`
    INSERT INTO finalizations (match_id, finalized, result, finalized_at, finalized_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertSignature = db.prepare(`
    INSERT INTO signatures (match_id, team, data_url, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  db.exec(`
    DELETE FROM signatures;
    DELETE FROM finalizations;
    DELETE FROM hole_scores;
    DELETE FROM pairs;
    DELETE FROM individuals;
    DELETE FROM players;
    DELETE FROM system_users;
  `);
  players.forEach(player => {
    insertPlayer.run(
      Number(player.id),
      player.team || '',
      player.name || '',
      player.username || '',
      player.password || '',
      player.isAdmin ? 1 : 0
    );
  });
  systemUsers.forEach(user => {
    insertSystemUser.run(
      user.username || user.name || '',
      user.name || user.username || '',
      user.password || '',
      user.isAdmin ? 1 : 0,
      user.access || null
    );
  });

  const { byNameAndTeam } = composePlayerMaps(loadPlayersFromDb());
  pairs.forEach(pair => {
    const tigers = playerIdsForSelection(byNameAndTeam, 'Tigers', pair.tigers, 2);
    const firmas = playerIdsForSelection(byNameAndTeam, 'Firmas', pair.firmas, 2);
    if (![...tigers, ...firmas].some(Boolean)) return;
    insertPair.run(Number(pair.id), tigers[0], tigers[1], firmas[0], firmas[1], now);
  });
  individuals.forEach(individual => {
    const [tigers] = playerIdsForSelection(byNameAndTeam, 'Tigers', individual.tigers, 1);
    const [firmas] = playerIdsForSelection(byNameAndTeam, 'Firmas', individual.firmas, 1);
    if (!tigers && !firmas) return;
    insertIndividual.run(Number(individual.id), tigers, firmas, now);
  });

  tournamentMatches().forEach(match => {
    const rows = scores[match.id];
    if (!rows) return;
    ['tigers', 'firmas'].forEach(team => {
      const holes = Array.isArray(rows[team]) ? rows[team] : [];
      holes.forEach((value, holeIndex) => {
        const cleanValue = String(value ?? '').trim();
        if (!cleanValue) return;
        insertScore.run(match.id, team, holeIndex, cleanValue, now);
      });
    });
  });

  Object.entries(finalizations).forEach(([matchId, record]) => {
    if (!isFinalizedRecord(record)) return;
    insertFinalization.run(
      matchId,
      1,
      record.result || '',
      record.finalizedAt || now,
      record.finalizedBy || '',
      now
    );
    Object.entries(record.signatures || {}).forEach(([team, dataUrl]) => {
      if (!['tigers', 'firmas'].includes(team) || !dataUrl) return;
      insertSignature.run(matchId, team, dataUrl, now);
    });
  });
}

function saveSharedState(state = sharedState) {
  syncRelationalTables(state);
  sharedState = composeStateFromDb();
  const json = JSON.stringify(sharedState, null, 2);
  db.prepare(`
    INSERT INTO app_state (id, json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(json, new Date().toISOString());
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, json);
}

function backupSharedState(reason = 'state') {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `${reason}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(sharedState, null, 2));
  } catch (error) {
    console.warn('No fue posible crear backup', error);
  }
}

function hasValues(values) {
  return values && Object.keys(values).length > 0;
}

function appState() {
  return sharedState.values || {};
}

function isFinalizedRecord(record) {
  return Boolean(record?.finalized);
}

function finalizationLabel(record) {
  const by = record?.finalizedBy ? ` por ${record.finalizedBy}` : '';
  const at = record?.finalizedAt ? ` el ${record.finalizedAt}` : '';
  return `${by}${at}`.trim();
}

function shouldUseIncomingRoster(current, incoming) {
  const currentPlayers = Array.isArray(current.players) ? current.players.length : 0;
  const incomingPlayers = Array.isArray(incoming.players) ? incoming.players.length : 0;
  if (incomingPlayers < 10) return false;
  return incomingPlayers >= currentPlayers;
}

function mergeRosterState(current, next, incoming) {
  if (shouldUseIncomingRoster(current, incoming)) {
    next.players = incoming.players;
    if (Array.isArray(incoming.systemUsers)) next.systemUsers = incoming.systemUsers;
    if (Array.isArray(incoming.pairs)) next.pairs = incoming.pairs;
    if (Array.isArray(incoming.individuals)) next.individuals = incoming.individuals;
    return;
  }

  if (Array.isArray(current.players)) next.players = current.players;
  if (Array.isArray(current.systemUsers)) next.systemUsers = current.systemUsers;
  if (Array.isArray(current.pairs)) next.pairs = current.pairs;
  if (Array.isArray(current.individuals)) next.individuals = current.individuals;
}

function mergeOnlyRoster(incoming) {
  const current = appState();
  const next = { ...current };
  if (shouldUseIncomingRoster(current, incoming || {})) {
    next.players = incoming.players;
    if (Array.isArray(incoming.systemUsers)) next.systemUsers = incoming.systemUsers;
  }
  sharedState = { values: next };
}

function mergeIncomingState(incoming, options = {}) {
  const current = appState();
  const next = { ...(incoming || {}) };
  const currentFinalizations = current.finalizations || {};
  const incomingFinalizations = next.finalizations || {};
  next.finalizations = { ...incomingFinalizations };
  mergeRosterState(current, next, incoming || {});

  Object.entries(currentFinalizations).forEach(([matchId, record]) => {
    if (!isFinalizedRecord(record)) return;
    if (options.allowUnlockMatchId === matchId) return;
    if (options.allowFinalizeMatchId === matchId) return;
    next.finalizations[matchId] = record;
    if (current.values?.[matchId]) {
      next.values = { ...(next.values || {}), [matchId]: current.values[matchId] };
    }
  });

  if (options.allowFinalizeMatchId && incomingFinalizations[options.allowFinalizeMatchId]) {
    next.finalizations[options.allowFinalizeMatchId] = incomingFinalizations[options.allowFinalizeMatchId];
  }

  sharedState = { values: next };
}

function setHoleValue(message) {
  const matchId = message.matchId;
  const team = message.team;
  const hole = Number(message.hole);
  if (!matchId || !['tigers', 'firmas'].includes(team) || !Number.isInteger(hole) || hole < 0) return false;
  if (isFinalizedRecord(appState().finalizations?.[matchId])) return false;

  const current = appState();
  current.values = current.values || {};
  const incomingRows = current.values[matchId] || {};
  current.values[matchId] = {
    tigers: Array.isArray(incomingRows.tigers) ? [...incomingRows.tigers] : [],
    firmas: Array.isArray(incomingRows.firmas) ? [...incomingRows.firmas] : []
  };
  while (current.values[matchId].tigers.length <= hole) current.values[matchId].tigers.push('');
  while (current.values[matchId].firmas.length <= hole) current.values[matchId].firmas.push('');
  const previousValue = current.values[matchId][team][hole] ?? '';
  const nextValue = message.value ?? '';
  current.values[matchId][team][hole] = nextValue;
  sharedState = { values: current };
  return { matchId, team, hole, previousValue, nextValue };
}

function staticFilePath(requestUrl) {
  const url = new URL(requestUrl, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(ROOT)) return null;
  return filePath;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === '/api/health') {
    const body = JSON.stringify({
      ok: true,
      database: path.basename(DB_FILE),
      players: db.prepare('SELECT COUNT(*) AS total FROM players').get().total,
      systemUsers: db.prepare('SELECT COUNT(*) AS total FROM system_users').get().total,
      pairs: configuredPairCount(),
      individuals: configuredIndividualCount(),
      matches: db.prepare('SELECT COUNT(*) AS total FROM matches').get().total,
      matchesWithScores: db.prepare('SELECT COUNT(DISTINCT match_id) AS total FROM hole_scores').get().total,
      scores: db.prepare('SELECT COUNT(*) AS total FROM hole_scores').get().total,
      finalizations: db.prepare('SELECT COUNT(*) AS total FROM finalizations WHERE finalized = 1').get().total,
      signatures: db.prepare('SELECT COUNT(*) AS total FROM signatures').get().total,
      auditLog: db.prepare('SELECT COUNT(*) AS total FROM audit_log').get().total,
      updatedAt: new Date().toISOString()
    });
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(body);
    return;
  }

  const filePath = staticFilePath(req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    res.end(data);
  });
}

function wsAcceptValue(key) {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

function encodeFrame(payload) {
  const body = Buffer.from(payload);
  const header = [];
  header.push(0x81);
  if (body.length < 126) {
    header.push(body.length);
  } else if (body.length < 65536) {
    header.push(126, (body.length >> 8) & 255, body.length & 255);
  } else {
    header.push(127, 0, 0, 0, 0);
    header.push((body.length / 2 ** 24) & 255, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255);
  }
  return Buffer.concat([Buffer.from(header), body]);
}

function decodeFrames(buffer, onMessage) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      length = high * 2 ** 32 + low;
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) break;

    if (opcode === 0x8) return frameEnd;
    if (opcode === 0x1) {
      const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : null;
      const payloadStart = offset + headerLength + maskLength;
      const payload = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) {
        payload[i] = masked ? buffer[payloadStart + i] ^ mask[i % 4] : buffer[payloadStart + i];
      }
      onMessage(payload.toString('utf8'));
    }

    offset = frameEnd;
  }
  return offset;
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(message)));
}

function broadcast(message) {
  for (const client of clients) send(client, message);
}

function handleMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === 'hello') {
    send(socket, { type: 'state', values: sharedState.values });
    return;
  }

  if (message.type === 'set-state') {
    mergeIncomingState(message.values || {});
    saveSharedState();
    audit('set-state', {
      players: Array.isArray(message.values?.players) ? message.values.players.length : 0,
      pairs: Array.isArray(message.values?.pairs) ? message.values.pairs.filter(item => item.tigers || item.firmas).length : 0,
      individuals: Array.isArray(message.values?.individuals) ? message.values.individuals.filter(item => item.tigers || item.firmas).length : 0
    }, null, messageUsername(message));
    broadcast({ type: 'state', values: sharedState.values });
    return;
  }

  if (message.type === 'set-hole') {
    const change = setHoleValue(message);
    if (!change) return;
    saveSharedState();
    if (String(change.previousValue ?? '') !== String(change.nextValue ?? '')) {
      audit('set-hole', {
        team: change.team,
        hole: change.hole,
        previousValue: change.previousValue,
        nextValue: change.nextValue
      }, change.matchId, messageUsername(message));
    }
    broadcast({ type: 'state', values: sharedState.values });
    return;
  }

  if (message.type === 'finalize-match') {
    const matchId = message.matchId;
    const incoming = message.values || {};
    const finalization = message.finalization || incoming.finalizations?.[matchId];
    const existing = appState().finalizations?.[matchId];

    if (!matchId || !isFinalizedRecord(finalization)) return;

    if (isFinalizedRecord(existing)) {
      const detail = finalizationLabel(existing);
      audit('finalize-rejected', {
        existing: {
          finalizedBy: existing.finalizedBy || '',
          finalizedAt: existing.finalizedAt || '',
          result: existing.result || ''
        }
      }, matchId, messageUsername(message));
      send(socket, {
        type: 'finalize-rejected',
        matchId,
        message: `Esta tarjeta ya fue finalizada${detail ? ` ${detail}` : ''}.`,
        values: sharedState.values
      });
      return;
    }

    mergeIncomingState({
      ...incoming,
      finalizations: {
        ...(incoming.finalizations || {}),
        [matchId]: finalization
      }
    }, { allowFinalizeMatchId: matchId });
    saveSharedState();
    audit('finalize-match', {
      result: finalization.result || '',
      finalizedAt: finalization.finalizedAt || '',
      finalizedBy: finalization.finalizedBy || ''
    }, matchId, messageUsername(message));
    broadcast({ type: 'state', values: sharedState.values });
    return;
  }

  if (message.type === 'unlock-match') {
    backupSharedState(`before-unlock-${message.matchId || 'match'}`);
    mergeIncomingState(message.values || {}, { allowUnlockMatchId: message.matchId });
    saveSharedState();
    audit('unlock-match', {}, message.matchId || null, messageUsername(message));
    broadcast({ type: 'state', values: sharedState.values });
    return;
  }

  if (message.type === 'reset') {
    backupSharedState('before-reset');
    const current = appState();
    sharedState = {
      values: {
        players: current.players || [],
        systemUsers: current.systemUsers || [],
        pairs: current.pairs || emptyPairs(),
        individuals: current.individuals || emptyIndividuals(),
        values: {},
        finalizations: {}
      }
    };
    saveSharedState();
    audit('reset-cards', {
      previousScoredMatches: current.values ? Object.values(current.values).filter(rows => Object.values(rows || {}).flat().some(Boolean)).length : 0,
      previousFinalizations: current.finalizations ? Object.keys(current.finalizations).length : 0
    }, null, messageUsername(message));
    broadcast({ type: 'state', values: sharedState.values });
  }
}

const server = http.createServer(serveStatic);

server.on('upgrade', (req, socket) => {
  if (req.url !== '/sync' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAcceptValue(key)}`,
    '',
    ''
  ].join('\r\n'));

  clients.add(socket);
  send(socket, { type: 'state', values: sharedState.values });

  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    const consumed = decodeFrames(pending, raw => handleMessage(socket, raw));
    pending = pending.subarray(consumed);
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

server.listen(PORT, HOST, () => {
  console.log(`Ryder server listening on http://${HOST}:${PORT}`);
});
