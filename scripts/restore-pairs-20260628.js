const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'ryder.sqlite');
const RECOVERED_PAIRS_FILE = path.join(ROOT, 'data', 'recovered-pairs-20260628.json');

const RECOVERED_PAIRS = JSON.parse(fs.readFileSync(RECOVERED_PAIRS_FILE, 'utf8'));

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase('es-CO');
}

function splitSelection(value) {
  return String(value || '').split('&').map(item => item.trim()).filter(Boolean);
}

function sqlString(value) {
  return String(value).replace(/'/g, "''");
}

if (!fs.existsSync(DB_FILE)) {
  console.error(`No existe la base de datos: ${DB_FILE}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
const players = db.prepare('SELECT id, team, name FROM players ORDER BY id').all();
const byTeamAndName = new Map(players.map(player => [`${player.team}:${normalize(player.name)}`, player]));
const missing = [];

function playerIds(team, selection, expected) {
  const names = splitSelection(selection);
  while (names.length < expected) names.push('');
  return names.slice(0, expected).map(name => {
    const player = byTeamAndName.get(`${team}:${normalize(name)}`);
    if (!player) missing.push(`${team}: ${name}`);
    return player?.id || null;
  });
}

const resolved = RECOVERED_PAIRS.map(pair => {
  const tigers = playerIds('Tigers', pair.tigers, 2);
  const firmas = playerIds('Firmas', pair.firmas, 2);
  return { ...pair, tigers, firmas };
});

if (missing.length) {
  console.error('No se puede restaurar porque faltan jugadores en la tabla players:');
  [...new Set(missing)].forEach(name => console.error(`- ${name}`));
  process.exit(1);
}

fs.mkdirSync(path.join(DATA_DIR, 'recovery-backups'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(DATA_DIR, 'recovery-backups', `before-restore-pairs-20260628-${stamp}.sqlite`);
db.exec(`VACUUM INTO '${sqlString(backupFile)}'`);

const update = db.prepare(`
  INSERT INTO pairs (id, tigers_player_1_id, tigers_player_2_id, firmas_player_1_id, firmas_player_2_id, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    tigers_player_1_id = excluded.tigers_player_1_id,
    tigers_player_2_id = excluded.tigers_player_2_id,
    firmas_player_1_id = excluded.firmas_player_1_id,
    firmas_player_2_id = excluded.firmas_player_2_id,
    updated_at = excluded.updated_at
`);

const now = new Date().toISOString();
db.exec('BEGIN');
try {
  resolved.forEach(pair => {
    update.run(pair.id, pair.tigers[0], pair.tigers[1], pair.firmas[0], pair.firmas[1], now);
  });
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

console.log('Parejas restauradas correctamente para Scramble y Golpe a Golpe.');
console.log(`Backup creado en: ${backupFile}`);
RECOVERED_PAIRS.forEach(pair => {
  console.log(`${String(pair.id).padStart(2, '0')} | ${pair.tigers} vs ${pair.firmas}`);
});
