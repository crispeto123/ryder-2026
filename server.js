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
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS processed_mutations (
      mutation_id TEXT PRIMARY KEY,
      match_id TEXT,
      team TEXT,
      hole_index INTEGER,
      client_id TEXT,
      client_seq INTEGER,
      value TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(database, 'hole_scores', 'client_id', 'TEXT');
  ensureColumn(database, 'hole_scores', 'client_seq', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'hole_scores', 'mutation_id', 'TEXT');
  seedMatches(database);
  return database;
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(item => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

function rosterSideIsValid(playersByNameAndTeam, team, value, expected) {
  const names = splitSelection(value);
  if (names.length !== expected) return false;
  if (new Set(names.map(normalizeName)).size !== names.length) return false;
  return names.every(name => playersByNameAndTeam.has(`${team}:${normalizeName(name)}`));
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

function loadSettingsFromDb() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = { cardsEditingEnabled: false };
  rows.forEach(row => {
    if (row.key === 'cardsEditingEnabled') settings.cardsEditingEnabled = row.value === 'true';
  });
  return settings;
}

function composeStateFromDb() {
  const players = loadPlayersFromDb();
  const systemUsers = loadSystemUsersFromDb();
  const { byId } = composePlayerMaps(players);
  return {
    values: {
      values: composeScoresFromDb(),
      finalizations: composeFinalizationsFromDb(),
      settings: loadSettingsFromDb(),
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

function mutationMeta(message) {
  const clientSeq = Number(message.clientSeq || 0);
  return {
    mutationId: String(message.mutationId || `server-${crypto.randomUUID()}`),
    clientId: String(message.clientId || ''),
    clientSeq: Number.isFinite(clientSeq) ? clientSeq : 0
  };
}

function processedMutation(mutationId) {
  if (!mutationId) return null;
  return db.prepare('SELECT * FROM processed_mutations WHERE mutation_id = ?').get(mutationId) || null;
}

function latestAcceptedMutation(meta, matchId, team, hole) {
  if (!meta.clientId || !meta.clientSeq) return null;
  return db.prepare(`
    SELECT * FROM processed_mutations
    WHERE client_id = ?
      AND match_id = ?
      AND team = ?
      AND hole_index = ?
      AND status = 'accepted'
    ORDER BY client_seq DESC, created_at DESC
    LIMIT 1
  `).get(meta.clientId, matchId, team, hole) || null;
}

function recordProcessedMutation(meta, change, status) {
  db.prepare(`
    INSERT OR IGNORE INTO processed_mutations
      (mutation_id, match_id, team, hole_index, client_id, client_seq, value, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    meta.mutationId,
    change.matchId,
    change.team,
    change.hole,
    meta.clientId,
    meta.clientSeq,
    String(change.nextValue ?? change.value ?? ''),
    status,
    new Date().toISOString()
  );
}

function findUserRecord(username) {
  const key = normalizeName(username);
  if (!key) return null;
  return [...loadSystemUsersFromDb(), ...loadPlayersFromDb()].find(user =>
    normalizeName(user.username) === key || normalizeName(user.name) === key
  ) || null;
}

function userIsAdmin(username) {
  return Boolean(findUserRecord(username)?.isAdmin);
}

function cardsEditingEnabledFor(username) {
  return loadSettingsFromDb().cardsEditingEnabled || userIsAdmin(username);
}

function syncRelationalTables(state) {
  const values = state.values || {};
  const players = Array.isArray(values.players) ? values.players : [];
  const systemUsers = Array.isArray(values.systemUsers) ? values.systemUsers : [];
  const pairs = Array.isArray(values.pairs) ? values.pairs : [];
  const individuals = Array.isArray(values.individuals) ? values.individuals : [];
  const scores = values.values || {};
  const finalizations = values.finalizations || {};
  const settings = { ...loadSettingsFromDb(), ...(values.settings || {}) };
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
  const insertSetting = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
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
  insertSetting.run('cardsEditingEnabled', settings.cardsEditingEnabled ? 'true' : 'false', now);
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
  const meta = mutationMeta(message);
  const match = tournamentMatches().find(item => item.id === matchId);
  if (!matchId || !['tigers', 'firmas'].includes(team) || !Number.isInteger(hole) || hole < 0) return false;
  if (!match || !matchHasValidRoster(match)) return false;
  if (!cardsEditingEnabledFor(messageUsername(message))) return false;
  if (isFinalizedRecord(appState().finalizations?.[matchId])) return false;

  const duplicate = processedMutation(meta.mutationId);
  if (duplicate) {
    return {
      matchId,
      team,
      hole,
      nextValue: duplicate.value,
      mutationId: meta.mutationId,
      clientId: meta.clientId,
      clientSeq: meta.clientSeq,
      version: duplicate.created_at,
      duplicate: true,
      ignored: duplicate.status === 'ignored'
    };
  }

  const latest = latestAcceptedMutation(meta, matchId, team, hole);
  if (latest && Number(latest.client_seq || 0) > meta.clientSeq) {
    const ignored = {
      matchId,
      team,
      hole,
      nextValue: message.value ?? '',
      mutationId: meta.mutationId,
      clientId: meta.clientId,
      clientSeq: meta.clientSeq,
      ignored: true,
      reason: 'stale-client-seq',
      version: new Date().toISOString()
    };
    recordProcessedMutation(meta, ignored, 'ignored');
    return ignored;
  }

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
  const change = {
    matchId,
    team,
    hole,
    previousValue,
    nextValue,
    mutationId: meta.mutationId,
    clientId: meta.clientId,
    clientSeq: meta.clientSeq,
    version: new Date().toISOString()
  };
  recordProcessedMutation(meta, change, 'accepted');
  return change;
}

function matchRoster(match, values = appState()) {
  const empty = { tigers: '', firmas: '' };
  if (!match) return empty;
  if (match.type === 'Individual') {
    return (values.individuals || []).find(item => Number(item.id) === Number(match.individualId)) || empty;
  }
  return (values.pairs || []).find(item => Number(item.id) === Number(match.pairId)) || empty;
}

function matchHasValidRoster(match, values = appState()) {
  const roster = matchRoster(match, values);
  const expected = match?.type === 'Individual' ? 1 : 2;
  const { byNameAndTeam } = composePlayerMaps(loadPlayersFromDb());
  return rosterSideIsValid(byNameAndTeam, 'Tigers', roster.tigers, expected)
    && rosterSideIsValid(byNameAndTeam, 'Firmas', roster.firmas, expected);
}

function matchUserCanDownload(match, username) {
  if (userIsAdmin(username)) return true;
  const user = findUserRecord(username);
  const userName = normalizeName(user?.name || username);
  if (!userName) return false;
  const roster = matchRoster(match);
  return [roster.tigers, roster.firmas]
    .flatMap(splitSelection)
    .some(playerName => normalizeName(playerName) === userName);
}

function asciiText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
}

function pdfEscape(value) {
  return asciiText(value).replace(/[\\()]/g, '\\$&');
}

function buildSimplePdf(lines) {
  const content = [
    'BT',
    '/F1 12 Tf',
    '50 790 Td',
    '15 TL',
    ...lines.map((line, index) => `${index ? 'T* ' : ''}(${pdfEscape(line)}) Tj`),
    'ET'
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function pdfLinesForMatch(match, finalization) {
  const values = appState();
  const roster = matchRoster(match, values);
  const scores = values.values?.[match.id] || {};
  const tigers = Array.isArray(scores.tigers) ? scores.tigers : [];
  const firmas = Array.isArray(scores.firmas) ? scores.firmas : [];
  const lines = [
    'RYDER 2026 - TARJETA FINALIZADA',
    '',
    `Modalidad: ${match.type}`,
    `Partido: ${match.title}`,
    `Tigers: ${roster.tigers || '-'}`,
    `Firmas: ${roster.firmas || '-'}`,
    `Resultado: ${finalization.result || '-'}`,
    `Finalizado por: ${finalization.finalizedBy || '-'}`,
    `Fecha finalizacion: ${formatColombiaDateTime(finalization.finalizedAt)}`,
    `Firmas registradas: Tigers ${finalization.signatures?.tigers ? 'SI' : 'NO'} / Firmas ${finalization.signatures?.firmas ? 'SI' : 'NO'}`,
    '',
    'Hoyo     Tigers     Firmas'
  ];
  for (let index = 0; index < Number(match.holes || 0); index += 1) {
    const tigerScore = String(tigers[index] ?? '').trim();
    const firmaScore = String(firmas[index] ?? '').trim();
    lines.push(`H${String(index + 1).padStart(2, '0')}      ${tigerScore || '-'}          ${firmaScore || '-'}`);
  }
  return lines;
}

function formatColombiaDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function svgEscape(value) {
  return htmlEscape(value);
}

function assetDataUri(fileName) {
  try {
    const filePath = path.join(ROOT, 'assets', fileName);
    const data = fs.readFileSync(filePath).toString('base64');
    return `data:image/png;base64,${data}`;
  } catch {
    return '';
  }
}

function printScoreRows(match) {
  const values = appState();
  const scores = values.values?.[match.id] || {};
  const tigers = Array.isArray(scores.tigers) ? scores.tigers : [];
  const firmas = Array.isArray(scores.firmas) ? scores.firmas : [];
  return Array.from({ length: Number(match.holes || 0) }, (_, index) => {
    const tigerScore = String(tigers[index] ?? '').trim();
    const firmaScore = String(firmas[index] ?? '').trim();
    return {
      hole: `H${index + 1}`,
      tigerScore: tigerScore || '-',
      firmaScore: firmaScore || '-'
    };
  });
}

function signatureBlock(teamLabel, signature) {
  return `
    <section class="signature-box">
      <h3>${htmlEscape(teamLabel)}</h3>
      ${signature ? `<img src="${htmlEscape(signature)}" alt="Firma ${htmlEscape(teamLabel)}">` : '<span>Sin firma registrada</span>'}
    </section>
  `;
}

function wrapSvgText(text, maxChars = 28, maxLines = 2) {
  const words = String(text || '-').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  words.forEach(word => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  });
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function svgTextLines(text, x, y, options = {}) {
  const lines = wrapSvgText(text, options.maxChars || 28, options.maxLines || 2);
  return lines.map((line, index) =>
    `<text x="${x}" y="${y + (index * (options.lineHeight || 24))}" text-anchor="${options.anchor || 'middle'}" class="${options.className || ''}">${svgEscape(line)}</text>`
  ).join('');
}

function buildScoreGridSvg(rows, roster, startIndex, y) {
  const visibleRows = rows.slice(startIndex, startIndex + 9);
  const x = 54;
  const width = 852;
  const labelWidth = 150;
  const holeWidth = (width - labelWidth) / 9;
  const headerHeight = 34;
  const rowHeight = 42;
  const headerCells = visibleRows.map((row, index) => {
    const cellX = x + labelWidth + (index * holeWidth);
    return `
      <rect x="${cellX}" y="${y}" width="${holeWidth}" height="${headerHeight}" class="gridHead"/>
      <text x="${cellX + (holeWidth / 2)}" y="${y + 23}" class="gridHeadText">${svgEscape(row.hole)}</text>
    `;
  }).join('');
  const scoreCells = (team, scoreKey, rowY) => visibleRows.map((row, index) => {
    const cellX = x + labelWidth + (index * holeWidth);
    return `
      <rect x="${cellX}" y="${rowY}" width="${holeWidth}" height="${rowHeight}" class="gridCell"/>
      <text x="${cellX + (holeWidth / 2)}" y="${rowY + 28}" class="gridScore">${svgEscape(row[scoreKey])}</text>
    `;
  }).join('');
  return `
    <rect x="${x}" y="${y}" width="${width}" height="${headerHeight + (rowHeight * 2)}" rx="12" class="gridBox"/>
    <rect x="${x}" y="${y}" width="${labelWidth}" height="${headerHeight}" class="gridHead"/>
    <text x="${x + (labelWidth / 2)}" y="${y + 23}" class="gridHeadText">EQUIPO</text>
    ${headerCells}
    <rect x="${x}" y="${y + headerHeight}" width="${labelWidth}" height="${rowHeight}" class="gridLabelCell"/>
    <text x="${x + 14}" y="${y + headerHeight + 27}" class="gridTeam" text-anchor="start">${svgEscape(roster.tigers || 'Tigers')}</text>
    ${scoreCells('tigers', 'tigerScore', y + headerHeight)}
    <rect x="${x}" y="${y + headerHeight + rowHeight}" width="${labelWidth}" height="${rowHeight}" class="gridLabelCell alt"/>
    <text x="${x + 14}" y="${y + headerHeight + rowHeight + 27}" class="gridTeam" text-anchor="start">${svgEscape(roster.firmas || 'Firmas')}</text>
    ${scoreCells('firmas', 'firmaScore', y + headerHeight + rowHeight)}
  `;
}

function buildMatchImageSvg(match, finalization) {
  const values = appState();
  const roster = matchRoster(match, values);
  const rows = printScoreRows(match);
  const tableY = 430;
  const gridHeight = rows.length > 9 ? 254 : 118;
  const signatureY = tableY + gridHeight + 34;
  const height = signatureY + 170;
  const tigersLogo = assetDataUri('tigers-header.png');
  const firmasLogo = assetDataUri('firmas-header.png');
  const finalizedAt = formatColombiaDateTime(finalization.finalizedAt);
  const scoreGrid = rows.length > 9
    ? `${buildScoreGridSvg(rows, roster, 0, tableY)}${buildScoreGridSvg(rows, roster, 9, tableY + 136)}`
    : buildScoreGridSvg(rows, roster, 0, tableY);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960px" height="${height}px" viewBox="0 0 960 ${height}">
  <defs>
    <style>
      .bg{fill:#0f2138}.panel{fill:#132946;stroke:#2f4564;stroke-width:2}.card{fill:#f8fafc;stroke:#dbe4f0;stroke-width:2}.title{font:900 42px Arial,Helvetica,sans-serif;fill:#eef5ff}.sub{font:800 15px Arial,Helvetica,sans-serif;fill:#b8c5d9;text-transform:uppercase}.team{font:900 22px Arial,Helvetica,sans-serif;fill:#172033}.players{font:800 17px Arial,Helvetica,sans-serif;fill:#41516a}.vs{font:900 42px Arial,Helvetica,sans-serif;fill:#f59e0b}.result{font:900 28px Arial,Helvetica,sans-serif;fill:#f59e0b}.metaLabel{font:700 13px Arial,Helvetica,sans-serif;fill:#b8c5d9}.metaValue{font:900 15px Arial,Helvetica,sans-serif;fill:#eef5ff}.gridBox{fill:#10233b;stroke:#2f4564;stroke-width:1}.gridHead{fill:#132a48;stroke:#2f4564;stroke-width:1}.gridHeadText{font:900 13px Arial,Helvetica,sans-serif;fill:#dce8f8;text-anchor:middle}.gridCell{fill:#0d1726;stroke:#2f4564;stroke-width:1}.gridLabelCell{fill:#10233b;stroke:#2f4564;stroke-width:1}.gridLabelCell.alt{fill:#132a48}.gridTeam{font:900 14px Arial,Helvetica,sans-serif;fill:#eef5ff}.gridScore{font:900 20px Arial,Helvetica,sans-serif;fill:#eef5ff;text-anchor:middle}.sigTitle{font:900 14px Arial,Helvetica,sans-serif;fill:#172033}.stamp{font:900 24px Arial,Helvetica,sans-serif;fill:#f59e0b}
    </style>
  </defs>
  <rect width="960" height="${height}" class="bg"/>
  <rect x="24" y="24" width="912" height="${height - 48}" rx="22" class="panel"/>
  <text x="480" y="82" text-anchor="middle" class="title">RYDER 2026</text>
  <text x="480" y="112" text-anchor="middle" class="sub">Tarjeta finalizada</text>
  <rect x="54" y="140" width="348" height="154" rx="18" class="card"/>
  ${tigersLogo ? `<image href="${tigersLogo}" x="78" y="166" width="104" height="104" preserveAspectRatio="xMidYMid meet"/>` : ''}
  <text x="276" y="184" text-anchor="middle" class="team">TIGERS</text>
  ${svgTextLines(roster.tigers || '-', 276, 218, { className: 'players', maxChars: 24 })}
  <text x="480" y="232" text-anchor="middle" class="vs">VS</text>
  <rect x="558" y="140" width="348" height="154" rx="18" class="card"/>
  ${firmasLogo ? `<image href="${firmasLogo}" x="582" y="166" width="104" height="104" preserveAspectRatio="xMidYMid meet"/>` : ''}
  <text x="780" y="184" text-anchor="middle" class="team">FIRMAS</text>
  ${svgTextLines(roster.firmas || '-', 780, 218, { className: 'players', maxChars: 24 })}
  <rect x="54" y="318" width="852" height="52" rx="14" fill="rgba(245,158,11,0.08)" stroke="rgba(245,158,11,0.55)" stroke-width="2"/>
  <text x="480" y="353" text-anchor="middle" class="result">${svgEscape(finalization.result || 'FINALIZADO')}</text>
  <text x="120" y="402" class="metaLabel">Modalidad</text>
  <text x="120" y="424" class="metaValue">${svgEscape(match.type)}</text>
  <text x="390" y="402" class="metaLabel">Partido</text>
  <text x="390" y="424" class="metaValue">${svgEscape(match.title)}</text>
  <text x="650" y="402" class="metaLabel">Finalizado</text>
  <text x="650" y="424" class="metaValue">${svgEscape(finalizedAt)}</text>
  ${scoreGrid}
  <rect x="54" y="${signatureY}" width="400" height="118" rx="14" class="card"/>
  <text x="254" y="${signatureY + 28}" text-anchor="middle" class="sigTitle">FIRMA TIGERS</text>
  ${finalization.signatures?.tigers ? `<image href="${svgEscape(finalization.signatures.tigers)}" x="78" y="${signatureY + 38}" width="352" height="64" preserveAspectRatio="xMidYMid meet"/>` : ''}
  <rect x="506" y="${signatureY}" width="400" height="118" rx="14" class="card"/>
  <text x="706" y="${signatureY + 28}" text-anchor="middle" class="sigTitle">FIRMA FIRMAS</text>
  ${finalization.signatures?.firmas ? `<image href="${svgEscape(finalization.signatures.firmas)}" x="530" y="${signatureY + 38}" width="352" height="64" preserveAspectRatio="xMidYMid meet"/>` : ''}
  <g transform="translate(744 ${height - 84}) rotate(-6)">
    <rect x="0" y="0" width="156" height="44" rx="10" fill="none" stroke="#f59e0b" stroke-width="4"/>
    <text x="78" y="30" text-anchor="middle" class="stamp">FINALIZADO</text>
  </g>
</svg>`;
}

function buildMatchPrintHtml(match, finalization) {
  const values = appState();
  const roster = matchRoster(match, values);
  const rows = printScoreRows(match).map(row => `
    <tr>
      <td>${htmlEscape(row.hole)}</td>
      <td>${htmlEscape(row.tigerScore)}</td>
      <td>${htmlEscape(row.firmaScore)}</td>
    </tr>
  `).join('');
  const finalizedAt = formatColombiaDateTime(finalization.finalizedAt);
  const result = finalization.result || 'FINALIZADO';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(match.title)} - Tarjeta finalizada</title>
  <style>
    :root {
      color-scheme: light;
      --navy: #0f2138;
      --navy-2: #162b46;
      --line: #2f4564;
      --text: #eef5ff;
      --muted: #b8c5d9;
      --gold: #f59e0b;
      --red: #ef4444;
      --blue: #3b82f6;
      --paper: #f8fafc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: var(--navy);
      color: var(--text);
    }
    .page {
      width: min(980px, calc(100% - 32px));
      margin: 24px auto;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(180deg, #132946 0%, #0f2138 100%);
      overflow: hidden;
      box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 14px 18px 0;
    }
    .actions button {
      border: 0;
      border-radius: 8px;
      padding: 10px 14px;
      font-weight: 800;
      color: #081423;
      background: var(--gold);
      cursor: pointer;
    }
    header {
      padding: 18px 22px 12px;
      text-align: center;
    }
    .title {
      margin: 0;
      font-size: 34px;
      letter-spacing: 0;
      font-weight: 900;
    }
    .subtitle {
      margin-top: 6px;
      color: var(--muted);
      font-size: 14px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .scoreboard {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      gap: 18px;
      padding: 10px 22px 20px;
    }
    .team-card {
      min-height: 176px;
      border-radius: 16px;
      background: var(--paper);
      color: #172033;
      display: grid;
      grid-template-columns: 118px minmax(0, 1fr);
      align-items: center;
      gap: 16px;
      padding: 16px;
      border: 1px solid #dbe4f0;
    }
    .team-card img {
      width: 112px;
      height: 112px;
      object-fit: contain;
      display: block;
    }
    .team-name {
      font-size: 20px;
      font-weight: 900;
      text-transform: uppercase;
      margin-bottom: 8px;
      word-break: break-word;
    }
    .players {
      min-height: 44px;
      color: #41516a;
      font-size: 15px;
      font-weight: 800;
      line-height: 1.25;
    }
    .vs {
      color: var(--gold);
      font-size: 36px;
      font-weight: 900;
    }
    .result {
      margin: 0 22px 18px;
      border: 1px solid rgba(245, 158, 11, 0.45);
      border-radius: 14px;
      padding: 14px 18px;
      text-align: center;
      font-size: 26px;
      font-weight: 900;
      color: var(--gold);
      background: rgba(245, 158, 11, 0.08);
      text-transform: uppercase;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      padding: 0 22px 18px;
    }
    .meta div {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.035);
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }
    .meta strong {
      display: block;
      margin-top: 4px;
      color: var(--text);
      font-size: 15px;
    }
    table {
      width: calc(100% - 44px);
      margin: 0 22px 20px;
      border-collapse: collapse;
      overflow: hidden;
      border-radius: 12px;
      background: #10233b;
      border: 1px solid var(--line);
    }
    th, td {
      padding: 10px 12px;
      text-align: center;
      border-bottom: 1px solid var(--line);
      font-weight: 800;
    }
    th {
      color: #dce8f8;
      font-size: 13px;
      text-transform: uppercase;
      background: #132a48;
    }
    td { font-size: 16px; }
    tr:last-child td { border-bottom: 0; }
    .signatures {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 0 22px 24px;
    }
    .signature-box {
      min-height: 154px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #f8fafc;
      color: #172033;
      padding: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .signature-box h3 {
      margin: 0 0 8px;
      font-size: 14px;
      text-transform: uppercase;
    }
    .signature-box img {
      width: 100%;
      max-height: 104px;
      object-fit: contain;
    }
    .signature-box span {
      color: #64748b;
      font-weight: 800;
    }
    .stamp {
      position: fixed;
      inset: auto 22px 18px auto;
      border: 3px solid rgba(245, 158, 11, 0.75);
      color: rgba(245, 158, 11, 0.9);
      border-radius: 12px;
      padding: 8px 14px;
      font-size: 18px;
      font-weight: 900;
      transform: rotate(-6deg);
      text-transform: uppercase;
      pointer-events: none;
    }
    @media (max-width: 720px) {
      .scoreboard, .meta, .signatures { grid-template-columns: 1fr; }
      .vs { text-align: center; }
      .team-card { grid-template-columns: 86px 1fr; min-height: 132px; }
      .team-card img { width: 82px; height: 82px; }
      .title { font-size: 28px; }
    }
    @media print {
      @page { size: A4; margin: 10mm; }
      body { background: white; }
      .page {
        width: 100%;
        margin: 0;
        border-radius: 0;
        box-shadow: none;
        break-inside: avoid;
      }
      .actions { display: none; }
      .stamp { position: absolute; }
      th, td { padding: 8px 10px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <div class="actions">
      <button type="button" onclick="window.print()">Guardar como PDF</button>
    </div>
    <header>
      <h1 class="title">RYDER 2026</h1>
      <div class="subtitle">Tarjeta finalizada</div>
    </header>
    <section class="scoreboard">
      <article class="team-card">
        <img src="/assets/tigers-header.png" alt="Tigers">
        <div>
          <div class="team-name">Tigers</div>
          <div class="players">${htmlEscape(roster.tigers || '-')}</div>
        </div>
      </article>
      <div class="vs">VS</div>
      <article class="team-card">
        <img src="/assets/firmas-header.png" alt="Firmas">
        <div>
          <div class="team-name">Firmas</div>
          <div class="players">${htmlEscape(roster.firmas || '-')}</div>
        </div>
      </article>
    </section>
    <section class="result">${htmlEscape(result)}</section>
    <section class="meta">
      <div>Modalidad<strong>${htmlEscape(match.type)}</strong></div>
      <div>Partido<strong>${htmlEscape(match.title)}</strong></div>
      <div>Finalizado<strong>${htmlEscape(finalizedAt)}</strong></div>
    </section>
    <table>
      <thead>
        <tr>
          <th>Hoyo</th>
          <th>Tigers</th>
          <th>Firmas</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <section class="signatures">
      ${signatureBlock('Tigers', finalization.signatures?.tigers)}
      ${signatureBlock('Firmas', finalization.signatures?.firmas)}
    </section>
  </main>
  <div class="stamp">Finalizado</div>
</body>
</html>`;
}

function serveMatchPdf(url, res) {
  const matchId = decodeURIComponent(url.pathname.match(/^\/api\/matches\/([^/]+)\/pdf$/)?.[1] || '');
  const match = tournamentMatches().find(item => item.id === matchId);
  const username = url.searchParams.get('user') || '';
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Partido no encontrado');
    return true;
  }
  const finalization = appState().finalizations?.[match.id];
  if (!isFinalizedRecord(finalization)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Solo se pueden descargar tarjetas finalizadas');
    return true;
  }
  if (!matchUserCanDownload(match, username)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No tienes acceso a esta tarjeta');
    return true;
  }
  const body = buildSimplePdf(pdfLinesForMatch(match, finalization));
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${match.id}-tarjeta.pdf"`,
    'Content-Length': body.length
  });
  res.end(body);
  return true;
}

function serveMatchPrint(url, res) {
  const matchId = decodeURIComponent(url.pathname.match(/^\/api\/matches\/([^/]+)\/print$/)?.[1] || '');
  const match = tournamentMatches().find(item => item.id === matchId);
  const username = url.searchParams.get('user') || '';
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Partido no encontrado');
    return true;
  }
  const finalization = appState().finalizations?.[match.id];
  if (!isFinalizedRecord(finalization)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Solo se pueden imprimir tarjetas finalizadas');
    return true;
  }
  if (!matchUserCanDownload(match, username)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No tienes acceso a esta tarjeta');
    return true;
  }
  const body = buildMatchPrintHtml(match, finalization);
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8'
  });
  res.end(body);
  return true;
}

function serveMatchImage(url, res) {
  const matchId = decodeURIComponent(url.pathname.match(/^\/api\/matches\/([^/]+)\/image$/)?.[1] || '');
  const match = tournamentMatches().find(item => item.id === matchId);
  const username = url.searchParams.get('user') || '';
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Partido no encontrado');
    return true;
  }
  const finalization = appState().finalizations?.[match.id];
  if (!isFinalizedRecord(finalization)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Solo se pueden descargar tarjetas finalizadas');
    return true;
  }
  if (!matchUserCanDownload(match, username)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No tienes acceso a esta tarjeta');
    return true;
  }
  const body = buildMatchImageSvg(match, finalization);
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Disposition': `attachment; filename="${match.id}-tarjeta.svg"`
  });
  res.end(body);
  return true;
}

function serveAuditLog(url, res) {
  const username = url.searchParams.get('user') || '';
  if (!userIsAdmin(username)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Solo administradores' }));
    return true;
  }
  const rows = db.prepare(`
    SELECT id, action, match_id AS matchId, username, payload, created_at AS createdAt
    FROM audit_log
    ORDER BY id DESC
    LIMIT 60
  `).all().map(row => {
    let payload = {};
    try {
      payload = row.payload ? JSON.parse(row.payload) : {};
    } catch {
      payload = { raw: row.payload || '' };
    }
    return { ...row, payload };
  });
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify({ ok: true, items: rows }));
  return true;
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
  if (/^\/api\/matches\/[^/]+\/print$/.test(url.pathname)) {
    serveMatchPrint(url, res);
    return;
  }
  if (/^\/api\/matches\/[^/]+\/image$/.test(url.pathname)) {
    serveMatchImage(url, res);
    return;
  }
  if (/^\/api\/matches\/[^/]+\/pdf$/.test(url.pathname)) {
    serveMatchPdf(url, res);
    return;
  }
  if (url.pathname === '/api/audit') {
    serveAuditLog(url, res);
    return;
  }
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
      cardsEditingEnabled: loadSettingsFromDb().cardsEditingEnabled,
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

  if (message.type === 'ping') {
    send(socket, { type: 'pong', at: message.at || Date.now() });
    return;
  }

  if (message.type === 'set-state') {
    const incomingValues = { ...(message.values || {}) };
    if (incomingValues.settings && !userIsAdmin(messageUsername(message))) {
      incomingValues.settings = appState().settings || loadSettingsFromDb();
    }
    mergeIncomingState(incomingValues);
    saveSharedState();
    audit('set-state', {
      players: Array.isArray(incomingValues.players) ? incomingValues.players.length : 0,
      pairs: Array.isArray(incomingValues.pairs) ? incomingValues.pairs.filter(item => item.tigers || item.firmas).length : 0,
      individuals: Array.isArray(incomingValues.individuals) ? incomingValues.individuals.filter(item => item.tigers || item.firmas).length : 0,
      cardsEditingEnabled: Boolean(incomingValues.settings?.cardsEditingEnabled)
    }, null, messageUsername(message));
    broadcast({ type: 'state', values: sharedState.values });
    return;
  }

  if (message.type === 'set-hole') {
    const change = setHoleValue(message);
    if (!change) {
      send(socket, {
        type: 'sync-warning',
        message: 'No se puede registrar una tarjeta sin jugadores configurados.',
        values: sharedState.values
      });
      return;
    }
    if (change.ignored) {
      send(socket, {
        type: 'hole-ignored',
        matchId: change.matchId,
        team: change.team,
        hole: change.hole,
        value: change.nextValue,
        mutationId: change.mutationId,
        clientId: change.clientId,
        clientSeq: change.clientSeq,
        version: change.version,
        message: 'Cambio ignorado: ya existe un dato mas nuevo para ese hoyo.'
      });
      return;
    }
    if (!change.duplicate) saveSharedState();
    if (!change.duplicate && String(change.previousValue ?? '') !== String(change.nextValue ?? '')) {
      audit('set-hole', {
        team: change.team,
        hole: change.hole,
        previousValue: change.previousValue,
        nextValue: change.nextValue,
        mutationId: change.mutationId,
        clientId: change.clientId,
        clientSeq: change.clientSeq
      }, change.matchId, messageUsername(message));
    }
    send(socket, {
      type: 'hole-saved',
      matchId: change.matchId,
      team: change.team,
      hole: change.hole,
      value: change.nextValue,
      mutationId: change.mutationId,
      clientId: change.clientId,
      clientSeq: change.clientSeq,
      version: change.version
    });
    broadcast({ type: 'state', values: sharedState.values });
    return;
  }

  if (message.type === 'finalize-match') {
    const matchId = message.matchId;
    const match = tournamentMatches().find(item => item.id === matchId);
    const finalization = message.finalization || message.values?.finalizations?.[matchId];
    const existing = appState().finalizations?.[matchId];

    if (!matchId || !isFinalizedRecord(finalization)) {
      send(socket, {
        type: 'finalize-rejected',
        matchId,
        message: 'No se recibio una finalizacion valida. Refresca la pagina e intenta de nuevo.',
        values: sharedState.values
      });
      return;
    }
    if (!match || !matchHasValidRoster(match)) {
      send(socket, {
        type: 'finalize-rejected',
        matchId,
        message: 'No se puede finalizar una tarjeta sin jugadores configurados.',
        values: sharedState.values
      });
      return;
    }
    if (!cardsEditingEnabledFor(messageUsername(message))) {
      audit('finalize-rejected', { reason: 'cards-editing-disabled' }, matchId, messageUsername(message));
      send(socket, {
        type: 'finalize-rejected',
        matchId,
        message: 'Edicion de tarjetas bloqueada por administracion.',
        values: sharedState.values
      });
      return;
    }

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

    try {
      const current = appState();
      sharedState = {
        values: {
          ...current,
          finalizations: {
            ...(current.finalizations || {}),
            [matchId]: finalization
          }
        }
      };
      saveSharedState();
      audit('finalize-match', {
        result: finalization.result || '',
        finalizedAt: finalization.finalizedAt || '',
        finalizedBy: finalization.finalizedBy || ''
      }, matchId, messageUsername(message));
      broadcast({ type: 'state', values: sharedState.values });
    } catch (error) {
      console.error('No fue posible finalizar tarjeta', error);
      sharedState = composeStateFromDb();
      audit('finalize-rejected', { reason: 'save-error', message: error.message || '' }, matchId, messageUsername(message));
      send(socket, {
        type: 'finalize-rejected',
        matchId,
        message: 'No se pudo guardar la finalizacion en el servidor. Refresca la pagina e intenta de nuevo.',
        values: sharedState.values
      });
    }
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
    if (!userIsAdmin(messageUsername(message))) {
      audit('reset-rejected', { reason: 'not-admin' }, null, messageUsername(message));
      send(socket, {
        type: 'sync-warning',
        message: 'Solo un administrador puede reiniciar tarjetas.',
        values: sharedState.values
      });
      return;
    }
    backupSharedState('before-reset');
    const current = appState();
    sharedState = {
      values: {
        players: current.players || [],
        systemUsers: current.systemUsers || [],
        pairs: current.pairs || emptyPairs(),
        individuals: current.individuals || emptyIndividuals(),
        settings: current.settings || loadSettingsFromDb(),
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
