const STORAGE_KEY = 'ryder-2026-matchplay-state-v1';
const SESSION_KEY = 'ryder-2026-session-user';
const HOLES = 9;
const INDIVIDUAL_HOLES = 18;

const state = {
  matches: structuredClone(window.RYDER_MATCHES || []),
  players: structuredClone(window.RYDER_PLAYERS || []),
  systemUsers: structuredClone(window.RYDER_SYSTEM_USERS || []),
  pairs: structuredClone(window.RYDER_PAIRS || []),
  individuals: structuredClone(window.RYDER_INDIVIDUALS || []),
  values: {},
  finalizations: {},
  settings: {
    cardsEditingEnabled: false
  },
  resultsFilter: 'Todas',
  resultsStatusFilter: 'Todos',
  cardsFilter: 'Todas',
  cardsStatusFilter: 'Todos',
  resultsTeamSearch: '',
  cardsTeamSearch: '',
  currentUser: null
};

let applyingRemoteState = false;
let signatureMatchId = '';
let unlockMatchId = '';
let downloadMatchId = '';
const pendingFinalizations = new Set();
const pendingFinalizationTimers = new Map();
const pendingHoleSaves = new Map();
const signatureInk = { tigers: false, firmas: false };

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

function allUsers() {
  return [...state.systemUsers, ...state.players];
}

function userKey(user) {
  return normalizeSearch(user?.username || user?.name);
}

function findUser(username) {
  const key = normalizeSearch(username);
  if (!key) return null;
  return allUsers().find(user => userKey(user) === key || normalizeSearch(user.name) === key) || null;
}

function activeUser() {
  return state.currentUser ? findUser(state.currentUser) : null;
}

function isTvUser() {
  const user = activeUser();
  return user?.access === 'tv' || normalizeSearch(user?.name) === 'tv' || normalizeSearch(user?.username) === 'tv';
}

function isAdminUser() {
  return toBoolean(activeUser()?.isAdmin);
}

function adminContactList() {
  const admins = allUsers()
    .filter(user => toBoolean(user?.isAdmin))
    .map(user => user.name || user.username)
    .filter(Boolean);
  return admins.length ? admins.join(' - ') : 'el administrador';
}

function currentUserName() {
  return activeUser()?.name || '';
}

function currentUsername() {
  return activeUser()?.username || activeUser()?.name || '';
}

function canWriteOnline() {
  return Boolean(window.RyderSync?.isOnline?.());
}

function warnOfflineWrite() {
  alert('Sin conexion con el servidor. No se pueden guardar cambios.');
}

function cardsEditingEnabled() {
  return toBoolean(state.settings?.cardsEditingEnabled);
}

function cardsEditingBlockedForUser() {
  return isLoggedIn() && !isAdminUser() && !cardsEditingEnabled();
}

function matchHasValidRoster(match) {
  if (!match) return false;
  const participant = participantForMatch(match);
  const roster = match.type === 'Individual' ? 'individuals' : 'pairs';
  return validateRosterSelection(roster, participant.id, 'tigers', participant.tigers)
    && validateRosterSelection(roster, participant.id, 'firmas', participant.firmas);
}

function canEditMatch(match) {
  if (!match) return false;
  if (!matchHasValidRoster(match)) return false;
  if (isAdminUser()) return true;
  const userName = normalizeSearch(currentUserName());
  if (!userName) return false;
  return [teamName(match, 'tigers'), teamName(match, 'firmas')].some(name =>
    parseSelection(name).some(playerName => normalizeSearch(playerName) === userName)
  );
}

function canWriteMatch(match) {
  return canEditMatch(match) && (isAdminUser() || cardsEditingEnabled());
}

function isFinalized(matchId) {
  return Boolean(state.finalizations[matchId]?.finalized);
}

function isFinalizationPending(matchId) {
  return pendingFinalizations.has(matchId);
}

function clearPendingFinalization(matchId) {
  if (!matchId) return;
  pendingFinalizations.delete(matchId);
  const timer = pendingFinalizationTimers.get(matchId);
  if (timer) window.clearTimeout(timer);
  pendingFinalizationTimers.delete(matchId);
}

function markFinalizationPending(matchId) {
  clearPendingFinalization(matchId);
  pendingFinalizations.add(matchId);
  pendingFinalizationTimers.set(matchId, window.setTimeout(() => {
    if (!pendingFinalizations.has(matchId) || isFinalized(matchId)) return;
    clearPendingFinalization(matchId);
    renderAll();
    alert('No se pudo confirmar la finalizacion con el servidor. Refresca la pagina y revisa si quedo finalizada antes de intentar otra vez.');
    window.RyderSync?.refresh?.();
  }, 20000));
}

function holeSaveKey(matchId, team, hole) {
  return `${matchId}|${team}|${hole}`;
}

function remoteHoleValue(matchId, team, hole) {
  return String(state.values?.[matchId]?.[team]?.[Number(hole)] ?? '');
}

function clearPendingHoleSave(key) {
  const pending = pendingHoleSaves.get(key);
  if (pending?.timer) window.clearTimeout(pending.timer);
  pendingHoleSaves.delete(key);
}

function markHoleSavePending(matchId, team, hole, value) {
  const key = holeSaveKey(matchId, team, hole);
  clearPendingHoleSave(key);
  pendingHoleSaves.set(key, {
    matchId,
    team,
    hole: Number(hole),
    value: String(value ?? ''),
    status: 'saving',
    timer: window.setTimeout(() => {
      const pending = pendingHoleSaves.get(key);
      if (!pending || pending.status !== 'saving') return;
      pending.status = 'failed';
      renderCards();
      window.RyderSync?.refresh?.();
    }, 8000)
  });
}

function reconcilePendingHoleSaves() {
  [...pendingHoleSaves.entries()].forEach(([key, pending]) => {
    if (remoteHoleValue(pending.matchId, pending.team, pending.hole) === pending.value) {
      clearPendingHoleSave(key);
    }
  });
}

function matchSaveStatus(matchId) {
  const entries = [...pendingHoleSaves.values()].filter(item => item.matchId === matchId);
  if (!entries.length) return null;
  if (entries.some(item => item.status === 'failed')) return 'Sin confirmar';
  return 'Guardando...';
}

function matchResultLabel(match, calc = calculateMatch(match.id)) {
  const holes = holesForMatch(match);
  if (!calc.hasStarted) return 'SIN INICIAR';
  if (calc.difference === 0) return 'AS';

  const lead = Math.abs(calc.difference);
  const remaining = calc.closed?.remaining ?? Math.max(0, holes - calc.played);
  const side = calc.difference > 0 ? 'TIGERS' : 'FIRMAS';
  const result = calc.closed ? `${lead}&${remaining}` : `${lead}UP`;
  return `${side} ${result}`;
}

function matchProgressLabel(match, calc = calculateMatch(match.id)) {
  if (isFinalized(match.id)) return winnerLabel(match, calc);
  if (!calc.hasStarted) return 'Sin iniciar';
  if (calc.closed) return winnerLabel(match, calc);
  return `Hoyo ${calc.played}`;
}

function winnerLabel(match, calc = calculateMatch(match.id)) {
  if (!calc.hasStarted || calc.difference === 0) return 'FINALIZADO Empate';
  return `FINALIZADO Gana ${calc.difference > 0 ? 'Tigers' : 'Firmas'}`;
}

function canFinalizeMatch(match, calc = calculateMatch(match.id)) {
  return Boolean(calc.hasStarted && (calc.closed || calc.played >= holesForMatch(match)));
}

function isLoggedIn() {
  return Boolean(activeUser());
}

function defaultTab() {
  if (isTvUser()) return 'resultados-tv';
  return 'resultados';
}

function canAccessTab(tabName) {
  if (!isLoggedIn()) return false;
  if (isTvUser()) return tabName === 'resultados-tv';
  if (isAdminUser()) return true;
  return tabName === 'resultados' || tabName === 'tarjetas';
}

function applyAccessControl() {
  const loggedIn = isLoggedIn();
  const tvOnly = isTvUser();
  const admin = isAdminUser();
  document.body.dataset.auth = loggedIn ? 'unlocked' : 'locked';
  document.body.dataset.user = activeUser()?.username || activeUser()?.name || '';
  document.body.dataset.admin = String(admin);
  document.getElementById('loginModal').hidden = loggedIn;
  document.querySelectorAll('.tab').forEach(tab => {
    tab.hidden = !canAccessTab(tab.dataset.tab);
  });
  const resetButton = document.getElementById('btnReset');
  if (resetButton) resetButton.hidden = !admin || tvOnly;
  const cardsEditingToggleWrap = document.getElementById('cardsEditingToggleWrap');
  const cardsEditingToggle = document.getElementById('cardsEditingToggle');
  const tournamentStatus = document.getElementById('tournamentStatus');
  if (cardsEditingToggleWrap) cardsEditingToggleWrap.hidden = !admin || tvOnly;
  if (cardsEditingToggle) cardsEditingToggle.checked = cardsEditingEnabled();
  if (tournamentStatus) tournamentStatus.hidden = !loggedIn || admin || tvOnly;
  const logoutButton = document.getElementById('btnLogout');
  if (logoutButton) logoutButton.hidden = !loggedIn;
  const userLabel = document.getElementById('currentUserLabel');
  if (userLabel) {
    userLabel.hidden = !loggedIn;
    userLabel.textContent = loggedIn ? `Usuario: ${activeUser()?.name || activeUser()?.username}` : '';
  }
  if (!loggedIn) return;
  if (tvOnly) {
    setActiveTab('resultados-tv');
  } else if (!canAccessTab(document.body.dataset.activeTab)) {
    setActiveTab('resultados');
  }
}

function renderSettingsControls() {
  const cardsEditingToggle = document.getElementById('cardsEditingToggle');
  if (cardsEditingToggle) cardsEditingToggle.checked = cardsEditingEnabled();
  const tournamentStatus = document.getElementById('tournamentStatus');
  if (tournamentStatus) {
    const enabled = cardsEditingEnabled();
    tournamentStatus.textContent = enabled ? 'EN TORNEO' : 'SIN EMPEZAR';
    tournamentStatus.classList.toggle('is-active', enabled);
  }
}

function mergePlayers(savedPlayers = []) {
  const byId = new Map(structuredClone(window.RYDER_PLAYERS || []).map(player => [String(player.id), player]));
  savedPlayers.forEach(player => {
    const base = byId.get(String(player.id)) || {};
    byId.set(String(player.id), { ...base, ...player });
  });
  return [...byId.values()].map(player => ({
    ...player,
    name: player.name || (window.RYDER_PLAYERS || []).find(base => String(base.id) === String(player.id))?.name || '',
    team: player.team || 'Tigers',
    username: player.username || '',
    password: player.password || '',
    isAdmin: toBoolean(player.isAdmin)
  }));
}

function holesForMatch(match) {
  return match?.type === 'Individual' ? INDIVIDUAL_HOLES : HOLES;
}

function pointsForMatch(match) {
  return match?.type === 'Individual' ? 2 : 1;
}

function totalDisputedPoints() {
  return state.matches.reduce((total, match) => total + pointsForMatch(match), 0);
}

function emptyMatchValues(holes = HOLES) {
  return { tigers: Array(holes).fill(''), firmas: Array(holes).fill('') };
}

function ensureStateShape() {
  state.matches.forEach(match => {
    const holes = holesForMatch(match);
    if (!state.values[match.id]) state.values[match.id] = emptyMatchValues(holes);
    if (!Array.isArray(state.values[match.id].tigers)) state.values[match.id].tigers = Array(holes).fill('');
    if (!Array.isArray(state.values[match.id].firmas)) state.values[match.id].firmas = Array(holes).fill('');
    while (state.values[match.id].tigers.length < holes) state.values[match.id].tigers.push('');
    while (state.values[match.id].firmas.length < holes) state.values[match.id].firmas.push('');
  });
}

function stateSnapshot() {
  return {
    values: state.values,
    finalizations: state.finalizations,
    settings: state.settings,
    players: state.players,
    systemUsers: state.systemUsers,
    pairs: state.pairs,
    individuals: state.individuals
  };
}

function isRosterPlaceholder(value) {
  const text = normalizeSearch(value);
  return text.includes('pareja #') || text.includes('jugador tigers #') || text.includes('jugador firmas #');
}

function cleanRosterPlaceholders(items = []) {
  return items.map(item => ({
    ...item,
    tigers: isRosterPlaceholder(item.tigers) ? '' : item.tigers,
    firmas: isRosterPlaceholder(item.firmas) ? '' : item.firmas
  }));
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  state.values = Object.hasOwn(snapshot, 'values') ? snapshot.values : {};
  state.finalizations = Object.hasOwn(snapshot, 'finalizations') ? snapshot.finalizations : {};
  state.settings = {
    cardsEditingEnabled: toBoolean(snapshot.settings?.cardsEditingEnabled)
  };
  if (Array.isArray(snapshot.players)) state.players = mergePlayers(snapshot.players);
  if (Array.isArray(snapshot.systemUsers)) state.systemUsers = snapshot.systemUsers;
  state.pairs = cleanRosterPlaceholders(Array.isArray(snapshot.pairs)
    ? snapshot.pairs
    : structuredClone(window.RYDER_PAIRS || []));
  state.individuals = cleanRosterPlaceholders(Array.isArray(snapshot.individuals)
    ? snapshot.individuals
    : structuredClone(window.RYDER_INDIVIDUALS || []));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    applySnapshot(saved);
  } catch (error) {
    console.warn('No fue posible cargar datos guardados', error);
  }
}

function loadSession() {
  state.currentUser = localStorage.getItem(SESSION_KEY) || '';
  if (!activeUser()) state.currentUser = '';
}

function saveSession(username) {
  state.currentUser = username;
  localStorage.setItem(SESSION_KEY, username);
}

function clearSession() {
  state.currentUser = '';
  localStorage.removeItem?.(SESSION_KEY);
}

function saveState(options = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stateSnapshot()));
  if (!applyingRemoteState && options.sync !== false) window.RyderSync?.save(stateSnapshot(), currentUsername());
}

function applyRemoteState(snapshot) {
  applyingRemoteState = true;
  if (snapshot && typeof snapshot === 'object') {
    applySnapshot(snapshot);
  } else {
    state.values = snapshot || {};
  }
  pendingFinalizations.forEach(matchId => {
    if (isFinalized(matchId)) clearPendingFinalization(matchId);
  });
  reconcilePendingHoleSaves();
  ensureStateShape();
  saveState();
  applyAccessControl();
  renderAll();
  applyingRemoteState = false;
}

function handleSyncWarning(event) {
  const matchId = event.detail?.matchId;
  if (matchId) {
    clearPendingFinalization(matchId);
  } else {
    [...pendingFinalizations].forEach(clearPendingFinalization);
  }
  if (event.detail?.values) applyRemoteState(event.detail.values);
  alert(event.detail?.message || 'La tarjeta ya fue finalizada por otro usuario.');
}

function formatNumber(value) {
  return Number(value).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function calculateMatch(matchId) {
  const match = state.matches.find(item => item.id === matchId);
  const holes = holesForMatch(match);
  const rows = state.values[matchId] || emptyMatchValues(holes);
  let difference = 0; // positivo: Tigers arriba. negativo: Firmas arriba.
  let played = 0;
  let closed = null;

  for (let i = 0; i < holes; i++) {
    const t = Number(rows.tigers[i]);
    const f = Number(rows.firmas[i]);
    if (Number.isFinite(t) && Number.isFinite(f) && t > 0 && f > 0) {
      played += 1;
      if (t < f) difference += 1;
      if (f < t) difference -= 1;
      const remaining = holes - played;
      if (Math.abs(difference) > remaining) {
        closed = {
          hole: i + 1,
          played,
          lead: Math.abs(difference),
          remaining,
          winner: difference > 0 ? 'Tigers' : 'Firmas'
        };
        break;
      }
    }
  }

  const hasStarted = played > 0;
  const tigersStatus = difference === 0 ? 'AS' : `${Math.abs(difference)}${difference > 0 ? 'Up' : 'Dw'}`;
  const firmasStatus = difference === 0 ? 'AS' : `${Math.abs(difference)}${difference < 0 ? 'Up' : 'Dw'}`;
  const pointValue = pointsForMatch(match);
  const tigersPoints = !hasStarted ? 0 : difference > 0 ? pointValue : difference === 0 ? pointValue / 2 : 0;
  const firmasPoints = !hasStarted ? 0 : difference < 0 ? pointValue : difference === 0 ? pointValue / 2 : 0;

  return { difference, played, hasStarted, closed, tigersStatus, firmasStatus, tigersPoints, firmasPoints };
}

function calculateTotals() {
  return state.matches.reduce((acc, match) => {
    const calc = calculateMatch(match.id);
    acc.tigers += calc.tigersPoints;
    acc.firmas += calc.firmasPoints;
    if (calc.hasStarted) acc.started += 1;
    if (isFinalized(match.id)) acc.finalized += 1;
    acc.byType[match.type] ??= { tigers: 0, firmas: 0, matches: 0 };
    acc.byType[match.type].tigers += calc.tigersPoints;
    acc.byType[match.type].firmas += calc.firmasPoints;
    acc.byType[match.type].matches += 1;
    return acc;
  }, { tigers: 0, firmas: 0, started: 0, finalized: 0, byType: {} });
}

function differenceText(tigers, firmas) {
  const diff = tigers - firmas;
  if (diff === 0) return 'AS';
  return `${Math.abs(diff).toLocaleString('es-CO')} ${diff > 0 ? 'Tigers' : 'Firmas'}`;
}

function statusClass(status) {
  if (status === 'AS') return 'status-as';
  return status.endsWith('Up') ? 'status-up' : 'status-dw';
}

function participantForMatch(match) {
  if (match.type === 'Individual') {
    return state.individuals.find(item => item.id === match.individualId) || match;
  }
  return state.pairs.find(item => item.id === match.pairId) || match;
}

function teamName(match, team) {
  return participantForMatch(match)?.[team] || '';
}

function playerTeamKey(team) {
  return team === 'firmas' ? 'Firmas' : 'Tigers';
}

function parseSelection(value) {
  return String(value || '').split('&').map(item => item.trim()).filter(Boolean);
}

function playersForTeam(team) {
  return state.players.filter(player => player.team === playerTeamKey(team) && player.name.trim());
}

function selectedNamesIn(collection, skipId, skipTeam) {
  const selected = new Set();
  collection.forEach(item => {
    ['tigers', 'firmas'].forEach(team => {
      if (String(item.id) === String(skipId) && team === skipTeam) return;
      parseSelection(item[team]).forEach(name => selected.add(normalizeSearch(name)));
    });
  });
  return selected;
}

function availablePlayersForRoster(roster, id, team, value, query = '') {
  const collection = roster === 'pairs' ? state.pairs : state.individuals;
  const selectedElsewhere = selectedNamesIn(collection, id, team);
  const selectedHere = new Set(parseSelection(value).map(normalizeSearch));
  const normalizedQuery = normalizeSearch(query);
  return playersForTeam(team).filter(player => {
    const normalized = normalizeSearch(player.name);
    return normalized && !selectedElsewhere.has(normalized) && !selectedHere.has(normalized) && (!normalizedQuery || normalized.includes(normalizedQuery));
  });
}

function validateRosterSelection(roster, id, team, value) {
  const names = parseSelection(value);
  const expected = roster === 'pairs' ? 2 : 1;
  if (names.length !== expected) return false;
  if (new Set(names.map(normalizeSearch)).size !== names.length) return false;

  const available = new Set(playersForTeam(team).map(player => normalizeSearch(player.name)));
  if (!names.every(name => available.has(normalizeSearch(name)))) return false;

  const collection = roster === 'pairs' ? state.pairs : state.individuals;
  const selectedElsewhere = selectedNamesIn(collection, id, team);
  return names.every(name => !selectedElsewhere.has(normalizeSearch(name)));
}

function playerSelectionStatus(name, roster) {
  const normalized = normalizeSearch(name);
  const collection = roster === 'pairs' ? state.pairs : state.individuals;
  return collection.some(item =>
    ['tigers', 'firmas'].some(team => parseSelection(item[team]).some(selected => normalizeSearch(selected) === normalized))
  );
}

function normalizeSearch(value) {
  return String(value || '').trim().toLocaleLowerCase('es-CO');
}

function teamNames() {
  return [...new Set(state.matches.flatMap(match => [teamName(match, 'tigers'), teamName(match, 'firmas')]))];
}

function playerNamesInMatches() {
  return [...new Set(state.matches.flatMap(match =>
    [teamName(match, 'tigers'), teamName(match, 'firmas')].flatMap(parseSelection)
  ).filter(Boolean))];
}

function playerSearchNames() {
  return [...new Set(state.players.map(player => player.name).filter(Boolean))];
}

function matchHasTeam(match, search) {
  const query = normalizeSearch(search);
  if (!query) return true;
  const exactOption = teamNames().some(team => normalizeSearch(team) === query);
  return [teamName(match, 'tigers'), teamName(match, 'firmas')].some(team => {
    const normalizedTeam = normalizeSearch(team);
    return exactOption ? normalizedTeam === query : normalizedTeam.includes(query);
  });
}

function matchHasPlayer(match, search) {
  const query = normalizeSearch(search);
  if (!query) return true;
  const players = [teamName(match, 'tigers'), teamName(match, 'firmas')].flatMap(parseSelection);
  const exactOption = playerSearchNames().some(name => normalizeSearch(name) === query);
  return players.some(name => {
    const normalizedName = normalizeSearch(name);
    return exactOption ? normalizedName === query : normalizedName.includes(query);
  });
}

function matchIncludesCurrentUser(match) {
  const userName = normalizeSearch(currentUserName());
  if (!userName) return false;
  return [teamName(match, 'tigers'), teamName(match, 'firmas')]
    .flatMap(parseSelection)
    .some(playerName => normalizeSearch(playerName) === userName);
}

function filteredMatches(view) {
  const typeFilter = view === 'resultados' ? state.resultsFilter : state.cardsFilter;
  const teamSearch = view === 'resultados' ? state.resultsTeamSearch : state.cardsTeamSearch;
  const statusFilter = view === 'resultados' ? state.resultsStatusFilter : state.cardsStatusFilter;
  const matches = state.matches.filter(match =>
    (typeFilter === 'Todas' || match.type === typeFilter) &&
    matchHasPlayer(match, teamSearch) &&
    matchHasStatus(match, statusFilter)
  );
  if (view === 'tarjetas' && isLoggedIn() && !isAdminUser()) {
    return matches.filter(match => canEditMatch(match));
  }
  if (view === 'tarjetas' && isLoggedIn() && isAdminUser()) {
    return matches
      .map((match, index) => ({ match, index, mine: matchIncludesCurrentUser(match) }))
      .sort((a, b) => Number(b.mine) - Number(a.mine) || a.index - b.index)
      .map(item => item.match);
  }
  return matches;
}

function matchHasStatus(match, statusFilter = 'Todos') {
  if (statusFilter === 'Todos') return true;
  if (statusFilter === 'Finalizados') return isFinalized(match.id);
  const calc = calculateMatch(match.id);
  if (statusFilter === 'Sin iniciar') return !calc.hasStarted && !isFinalized(match.id);
  if (statusFilter === 'En el campo') return calc.hasStarted && !isFinalized(match.id);
  return true;
}

function renderTeamOptions() {
  const datalist = document.getElementById('teamOptions');
  if (!datalist) return;
  const players = playerSearchNames().sort((a, b) =>
    a.localeCompare(b, 'es-CO', { numeric: true })
  );
  const options = players.map(player => `<option value="${escapeHtml(player)}"></option>`).join('');
  datalist.innerHTML = options;

  const playerSearchOptions = document.getElementById('playerSearchOptions');
  if (playerSearchOptions) {
    playerSearchOptions.innerHTML = options;
  }

  ['tigers', 'firmas'].forEach(team => {
    const options = document.getElementById(`${team}PlayerOptions`);
    if (!options) return;
    options.innerHTML = playersForTeam(team)
      .map(player => `<option value="${escapeHtml(player.name)}"></option>`)
      .join('');
  });
}

function renderScoreboard() {
  const totals = calculateTotals();
  document.getElementById('scoreTigers').textContent = formatNumber(totals.tigers);
  document.getElementById('scoreFirmas').textContent = formatNumber(totals.firmas);
  const inPlay = Math.max(0, totals.started - totals.finalized);
  document.getElementById('matchProgressLabel').textContent = `Partidos en el campo ${inPlay} / Finalizados ${totals.finalized}`;
  document.getElementById('startedMatches').textContent = `(puntos en disputa ${totalDisputedPoints()})`;

  const summary = document.getElementById('summaryByType');
  summary.innerHTML = Object.entries(totals.byType).map(([type, item]) => `
    <tr>
      <td><span class="badge small">${type}</span></td>
      <td><strong class="summary-points">${formatNumber(item.tigers)}</strong></td>
      <td><strong class="summary-points">${formatNumber(item.firmas)}</strong></td>
    </tr>
  `).join('');

  const tvSummary = document.getElementById('tvSummaryByType');
  if (tvSummary) {
    tvSummary.innerHTML = Object.entries(totals.byType).map(([type, item]) => `
      <tr>
        <td><span class="badge tv-badge">${type.toLocaleUpperCase('es-CO')}</span></td>
        <td><strong>${formatNumber(item.tigers)}</strong></td>
        <td><strong>${formatNumber(item.firmas)}</strong></td>
      </tr>
    `).join('');
  }
}

function renderResultsTable() {
  const tbody = document.getElementById('resultsBody');
  const matches = filteredMatches('resultados');
  if (!matches.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Sin resultados para esa busqueda.</td></tr>';
    return;
  }
  tbody.innerHTML = matches
    .map(match => {
    const calc = calculateMatch(match.id);
    const matchNumber = match.title.match(/#\d+$/)?.[0] || match.title;
    return `<tr>
      <td class="mode-match-cell"><span class="badge small">${match.type}</span><span class="match-number">${matchNumber}</span><span class="match-progress">${matchProgressLabel(match, calc)}</span></td>
      <td class="team-cell"><span class="status-cell ${statusClass(calc.tigersStatus)}">${calc.tigersStatus}</span><span class="team-points">${formatNumber(calc.tigersPoints)}</span><span>${escapeHtml(teamName(match, 'tigers'))}</span></td>
      <td class="team-cell"><span class="status-cell ${statusClass(calc.firmasStatus)}">${calc.firmasStatus}</span><span class="team-points">${formatNumber(calc.firmasPoints)}</span><span>${escapeHtml(teamName(match, 'firmas'))}</span></td>
    </tr>`;
  }).join('');
}

function holeInput(match, team, index) {
  const value = state.values[match.id][team][index] ?? '';
  const calc = calculateMatch(match.id);
  const closedRemaining = calc.closed && value === '';
  const disabled = canWriteOnline() && canWriteMatch(match) && !isFinalized(match.id) && !isFinalizationPending(match.id) && !closedRemaining ? '' : 'disabled';
  const pending = pendingHoleSaves.get(holeSaveKey(match.id, team, index));
  const saveClass = pending ? ` save-${pending.status}` : '';
  const saveTitle = pending?.status === 'failed'
    ? 'Sin confirmar en servidor'
    : pending ? 'Guardando en servidor' : '';
  return `<input class="hole-input${saveClass}" type="number" min="1" max="20" inputmode="numeric" value="${value}" data-match="${match.id}" data-team="${team}" data-hole="${index}" aria-label="${team} hoyo ${index + 1}" title="${saveTitle}" ${disabled}>`;
}

function holeHeaders(start, count = HOLES, extraClass = '') {
  return Array.from({ length: count }, (_, i) => `<div class="grid-hole ${extraClass}">H${start + i}</div>`).join('');
}

function holeInputs(match, team, start, count = HOLES) {
  return Array.from({ length: count }, (_, i) => holeInput(match, team, start + i - 1)).join('');
}

function scorecardGrid(match, calc) {
  const firstNine = `
    <div class="grid-label">Equipo</div>
    ${holeHeaders(1)}
    <div class="player-name tigers-name">${escapeHtml(teamName(match, 'tigers'))}</div>
    ${holeInputs(match, 'tigers', 1)}
    <div class="player-name firmas-name">${escapeHtml(teamName(match, 'firmas'))}</div>
    ${holeInputs(match, 'firmas', 1)}`;

  if (holesForMatch(match) === HOLES) return firstNine;

  return `${firstNine}
    <div class="grid-label second-nine">Equipo</div>
    ${holeHeaders(10, HOLES, 'second-nine')}
    <div class="player-name tigers-name">${escapeHtml(teamName(match, 'tigers'))}</div>
    ${holeInputs(match, 'tigers', 10)}
    <div class="player-name firmas-name">${escapeHtml(teamName(match, 'firmas'))}</div>
    ${holeInputs(match, 'firmas', 10)}`;
}

function renderCards() {
  const container = document.getElementById('cardsContainer');
  const template = document.getElementById('matchTemplate');
  container.innerHTML = '';

  const matches = filteredMatches('tarjetas');
  if (!matches.length) {
    container.innerHTML = '<p class="empty-state">Sin tarjetas para esa busqueda.</p>';
    return;
  }

  if (cardsEditingBlockedForUser()) {
    const notice = document.createElement('p');
    notice.className = 'cards-locked-notice';
    notice.textContent = 'Edicion de tarjetas bloqueada por administracion.';
    container.appendChild(notice);
  }

  matches
    .forEach(match => {
      const calc = calculateMatch(match.id);
      const node = template.content.cloneNode(true);
      const card = node.querySelector('.match-card');
      card.dataset.match = match.id;
      card.classList.toggle('finalized', isFinalized(match.id));
      card.classList.toggle('pending-finalization', isFinalizationPending(match.id));
      const matchNumber = match.title.match(/#\d+$/)?.[0] || match.title;
      node.querySelector('.badge').textContent = match.type;
      node.querySelector('h3').textContent = matchNumber;
      const saveStatus = matchSaveStatus(match.id);
      const actions = isFinalized(match.id)
        ? `${canEditMatch(match) ? `<button class="btn secondary card-download card-action" type="button" data-card-action="download" data-match="${match.id}">Descargar Tarjeta</button>` : ''}
          <button class="btn secondary card-action" type="button" data-card-action="unlock" data-match="${match.id}">Abrir tarjeta</button>`
        : isFinalizationPending(match.id)
          ? '<button class="btn secondary card-action" type="button" disabled>Finalizando...</button>'
        : canWriteMatch(match) && canFinalizeMatch(match, calc)
          ? `<button class="btn card-action" type="button" data-card-action="finalize" data-match="${match.id}">Finalizar</button>`
          : '';
      node.querySelector('.match-status').innerHTML = `
        <span class="match-summary">
          <span class="summary-team summary-tigers">Tigers <strong class="${statusClass(calc.tigersStatus)}">${calc.tigersStatus}</strong> <em>${formatNumber(calc.tigersPoints)} pts</em></span>
          <span class="summary-separator">/</span>
          <span class="summary-team summary-firmas">Firmas <strong class="${statusClass(calc.firmasStatus)}">${calc.firmasStatus}</strong> <em>${formatNumber(calc.firmasPoints)} pts</em></span>
        </span>
        ${saveStatus ? `<span class="save-status ${saveStatus === 'Sin confirmar' ? 'failed' : ''}">${saveStatus}</span>` : ''}
        ${actions}
      `;

      const grid = node.querySelector('.match-grid');
      if (calc.closed && !isFinalized(match.id)) {
        const notice = document.createElement('div');
        notice.className = 'match-defined-notice';
        notice.innerHTML = `<strong>${escapeHtml(winnerLabel(match, calc))}</strong><span>No es necesario jugar los hoyos restantes. Finaliza la tarjeta para bloquear el resultado.</span>`;
        card.insertBefore(notice, grid);
      }
      grid.innerHTML = scorecardGrid(match, calc);
      if (isFinalized(match.id)) {
        const watermark = document.createElement('div');
        watermark.className = 'finalized-watermark';
        watermark.innerHTML = `<span>FINALIZADO</span><strong>${escapeHtml(winnerLabel(match, calc).replace('FINALIZADO ', ''))}</strong>`;
        card.appendChild(watermark);
      }
      container.appendChild(node);
    });
}

function rosterInput(item, group, team) {
  const names = parseSelection(item[team]);
  const max = group === 'pairs' ? 2 : 1;
  const locked = rosterItemIsLocked(group, item.id);
  const isValid = validateRosterSelection(group, item.id, team, item[team]);
  const chips = names.map(name => `
    <span class="roster-chip">
      <button class="roster-remove" type="button" data-roster="${group}" data-id="${item.id}" data-team="${team}" data-name="${escapeHtml(name)}" aria-label="Quitar ${escapeHtml(name)}">×</button>
      <span>${escapeHtml(name)}</span>
    </span>
  `).join('');
  const input = !locked && names.length < max
    ? `<input class="roster-input" type="text" value="" data-roster="${group}" data-id="${item.id}" data-team="${team}" aria-label="${team} ${item.id}" autocomplete="off" placeholder="Buscar jugador">`
    : '';
  const lockLabel = locked ? ' title="Bloqueado por tarjeta iniciada o finalizada"' : '';
  return `<div class="roster-field ${isValid ? '' : 'invalid'} ${locked ? 'locked' : ''}" data-roster="${group}" data-id="${item.id}" data-team="${team}" aria-invalid="${!isValid}"${lockLabel}>${chips}${input}</div>`;
}

function playerInput(player, field) {
  const type = field === 'password' ? 'password' : 'text';
  return `<input class="player-input" type="${type}" value="${escapeHtml(player[field] || '')}" data-player="${player.id}" data-field="${field}" aria-label="${field} ${player.id}">`;
}

function playerPasswordInput(player) {
  return `<div class="password-field">
    <input class="player-input password-input" type="password" value="${escapeHtml(player.password || '')}" data-player="${player.id}" data-field="password" aria-label="password ${player.id}">
    <button class="password-toggle" type="button" data-password-player="${player.id}" aria-label="Mostrar contrasena"></button>
  </div>`;
}

function playerTeamSelect(player) {
  return `<select class="player-input" data-player="${player.id}" data-field="team" aria-label="equipo ${player.id}">
    <option value="Tigers" ${player.team === 'Tigers' ? 'selected' : ''}>Tigers</option>
    <option value="Firmas" ${player.team === 'Firmas' ? 'selected' : ''}>Firmas</option>
  </select>`;
}

function playerAdminSelect(player) {
  return `<select class="player-input" data-player="${player.id}" data-field="isAdmin" aria-label="admin ${player.id}">
    <option value="false" ${player.isAdmin ? '' : 'selected'}>False</option>
    <option value="true" ${player.isAdmin ? 'selected' : ''}>True</option>
  </select>`;
}

function renderRoster() {
  const playersBody = document.getElementById('playersBody');
  const pairsBody = document.getElementById('pairsBody');
  const individualsBody = document.getElementById('individualsBody');
  if (playersBody) {
    playersBody.innerHTML = state.players.map(player => `
      <tr>
        <td>${playerTeamSelect(player)}</td>
        <td>${playerInput(player, 'name')}</td>
        <td><span class="status-flag ${playerSelectionStatus(player.name, 'pairs') ? 'on' : ''}">${playerSelectionStatus(player.name, 'pairs') ? 'True' : 'False'}</span></td>
        <td><span class="status-flag ${playerSelectionStatus(player.name, 'individuals') ? 'on' : ''}">${playerSelectionStatus(player.name, 'individuals') ? 'True' : 'False'}</span></td>
        <td>${playerInput(player, 'username')}</td>
        <td>${playerPasswordInput(player)}</td>
        <td>${playerAdminSelect(player)}</td>
      </tr>
    `).join('');
  }
  if (pairsBody) {
    pairsBody.innerHTML = state.pairs.map(pair => `
      <tr>
        <td><strong>${pair.id}</strong></td>
        <td>${rosterInput(pair, 'pairs', 'tigers')}</td>
        <td>${rosterInput(pair, 'pairs', 'firmas')}</td>
      </tr>
    `).join('');
  }
  if (individualsBody) {
    individualsBody.innerHTML = state.individuals.map(individual => `
      <tr>
        <td><strong>${individual.id}</strong></td>
        <td>${rosterInput(individual, 'individuals', 'tigers')}</td>
        <td>${rosterInput(individual, 'individuals', 'firmas')}</td>
      </tr>
    `).join('');
  }
}

function renderAll() {
  const editingRoster = document.activeElement?.classList?.contains('roster-input') || document.activeElement?.classList?.contains('player-input');
  renderSettingsControls();
  renderScoreboard();
  renderTeamOptions();
  renderResultsTable();
  renderCards();
  if (!editingRoster) renderRoster();
}

function onInput(event) {
  const input = event.target.closest('.hole-input');
  if (!input) return;
  const { match, team, hole } = input.dataset;
  const matchItem = state.matches.find(item => item.id === match);
  if (!canWriteOnline()) {
    warnOfflineWrite();
    renderCards();
    return;
  }
  if (!canWriteMatch(matchItem) || isFinalized(match)) return;
  state.values[match][team][Number(hole)] = input.value;
  saveState({ sync: false });
  const sent = window.RyderSync?.setHole?.(match, team, Number(hole), input.value, currentUsername());
  if (sent) {
    markHoleSavePending(match, team, Number(hole), input.value);
  } else {
    warnOfflineWrite();
  }
  renderAll();
  const restored = document.querySelector(`[data-match="${match}"][data-team="${team}"][data-hole="${hole}"]`);
  restored?.focus();
}

function openSignatureModal(matchId) {
  const match = state.matches.find(item => item.id === matchId);
  const calc = match ? calculateMatch(match.id) : null;
  if (!canWriteOnline()) {
    warnOfflineWrite();
    return;
  }
  if (!match || !canWriteMatch(match) || isFinalized(matchId)) return;
  if (!canFinalizeMatch(match, calc)) {
    alert('Esta tarjeta aun no se puede finalizar. Debe estar definida por Match Play o tener todos los hoyos jugados.');
    return;
  }
  signatureMatchId = matchId;
  signatureInk.tigers = false;
  signatureInk.firmas = false;
  document.getElementById('signatureError').hidden = true;
  document.getElementById('signatureMatchLabel').textContent = `${match.title} - ${matchResultLabel(match, calc)}`;
  document.getElementById('signatureModal').hidden = false;
  clearSignatureCanvas('tigers');
  clearSignatureCanvas('firmas');
}

function closeSignatureModal() {
  document.getElementById('signatureModal').hidden = true;
  signatureMatchId = '';
}

function signatureCanvas(team) {
  return document.getElementById(team === 'firmas' ? 'signatureCanvasFirmas' : 'signatureCanvasTigers');
}

function compressedSignature(team) {
  const source = signatureCanvas(team);
  const target = document.createElement('canvas');
  target.width = 360;
  target.height = 124;
  const ctx = target.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.drawImage(source, 0, 0, target.width, target.height);
  return target.toDataURL('image/jpeg', 0.72);
}

function clearSignatureCanvas(team) {
  if (!team) {
    clearSignatureCanvas('tigers');
    clearSignatureCanvas('firmas');
    return;
  }
  const canvas = signatureCanvas(team);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  signatureInk[team] = false;
}

function clearAllSignatures() {
  clearSignatureCanvas('tigers');
  clearSignatureCanvas('firmas');
  document.getElementById('signatureError').hidden = true;
}

function finalizeCurrentMatch() {
  const match = state.matches.find(item => item.id === signatureMatchId);
  if (!match) return;
  if (!canWriteOnline()) {
    document.getElementById('signatureError').hidden = false;
    document.getElementById('signatureError').textContent = 'Sin conexion con el servidor. No se puede finalizar.';
    return;
  }
  const calc = calculateMatch(match.id);
  if (!canWriteMatch(match)) {
    document.getElementById('signatureError').hidden = false;
    document.getElementById('signatureError').textContent = 'Edicion de tarjetas bloqueada por administracion.';
    return;
  }
  if (!canFinalizeMatch(match, calc)) {
    document.getElementById('signatureError').hidden = false;
    document.getElementById('signatureError').textContent = 'Esta tarjeta aun no se puede finalizar. Debe estar definida por Match Play o tener todos los hoyos jugados.';
    return;
  }
  if (matchSaveStatus(match.id)) {
    document.getElementById('signatureError').hidden = false;
    document.getElementById('signatureError').textContent = 'Espera a que todos los hoyos queden guardados antes de finalizar.';
    window.RyderSync?.refresh?.();
    return;
  }
  if (!signatureInk.tigers || !signatureInk.firmas) {
    document.getElementById('signatureError').hidden = false;
    document.getElementById('signatureError').textContent = 'Dibuja la firma de Tigers y Firmas antes de finalizar.';
    return;
  }
  const finalization = {
    finalized: true,
    result: winnerLabel(match, calc),
    signatures: {
      tigers: compressedSignature('tigers'),
      firmas: compressedSignature('firmas')
    },
    finalizedAt: new Date().toISOString(),
    finalizedBy: currentUsername()
  };
  const sent = window.RyderSync?.finalize?.(match.id, {}, finalization, currentUsername());
  if (!sent) {
    document.getElementById('signatureError').hidden = false;
    document.getElementById('signatureError').textContent = 'Sin conexion con el servidor. No se puede finalizar.';
    return;
  }
  markFinalizationPending(match.id);
  closeSignatureModal();
  renderAll();
}

function openUnlockModal(matchId) {
  if (!canWriteOnline()) {
    warnOfflineWrite();
    return;
  }
  if (!isAdminUser()) {
    alert(`Tarjeta finalizada. Para abrirla comunícate con: ${adminContactList()}`);
    return;
  }
  unlockMatchId = matchId;
  document.getElementById('unlockUser').value = activeUser()?.username || activeUser()?.name || '';
  document.getElementById('unlockPassword').value = '';
  document.getElementById('unlockError').hidden = true;
  document.getElementById('unlockModal').hidden = false;
  document.getElementById('unlockUser').focus();
}

function closeUnlockModal() {
  document.getElementById('unlockModal').hidden = true;
  unlockMatchId = '';
}

function openDownloadModal(matchId) {
  const match = state.matches.find(item => item.id === matchId);
  if (!match || !isFinalized(match.id) || !canEditMatch(match)) return;
  downloadMatchId = match.id;
  const user = encodeURIComponent(currentUsername());
  const encodedMatch = encodeURIComponent(match.id);
  document.getElementById('downloadMatchLabel').textContent = `${match.title} - ${winnerLabel(match)}`;
  document.getElementById('downloadImageLink').dataset.imageUrl = `/api/matches/${encodedMatch}/image?user=${user}`;
  document.getElementById('downloadImageLink').dataset.fileName = `${match.id}-tarjeta.png`;
  document.getElementById('downloadPdfLink').href = `/api/matches/${encodedMatch}/print?user=${user}`;
  document.getElementById('downloadModal').hidden = false;
}

function closeDownloadModal() {
  document.getElementById('downloadModal').hidden = true;
  downloadMatchId = '';
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function downloadCardImage() {
  const button = document.getElementById('downloadImageLink');
  const imageUrl = button.dataset.imageUrl;
  const fileName = button.dataset.fileName || 'tarjeta.png';
  if (!imageUrl) return;
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = 'Generando...';
  try {
    const response = await fetch(imageUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('No fue posible generar la imagen.');
    const svgText = await response.text();
    const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(svgBlob);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = svgUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || 960;
    canvas.height = image.naturalHeight || 1200;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    URL.revokeObjectURL(svgUrl);
    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) throw new Error('No fue posible convertir la imagen.');
    downloadBlob(pngBlob, fileName);
    closeDownloadModal();
  } catch (error) {
    alert(error.message || 'No fue posible descargar la imagen.');
    window.open(imageUrl, '_blank', 'noopener');
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

function unlockCurrentMatch() {
  const user = findUser(document.getElementById('unlockUser').value);
  const password = document.getElementById('unlockPassword').value;
  if (!user || !toBoolean(user.isAdmin) || String(user.password || '') !== password) {
    document.getElementById('unlockError').hidden = false;
    document.getElementById('unlockPassword').select();
    return;
  }
  delete state.finalizations[unlockMatchId];
  saveState({ sync: false });
  window.RyderSync?.unlock?.(unlockMatchId, stateSnapshot(), currentUsername());
  closeUnlockModal();
  renderAll();
}

function onCardAction(event) {
  const button = event.target.closest('[data-card-action]');
  if (!button) return;
  if (button.dataset.cardAction === 'finalize') openSignatureModal(button.dataset.match);
  if (button.dataset.cardAction === 'unlock') openUnlockModal(button.dataset.match);
  if (button.dataset.cardAction === 'download') openDownloadModal(button.dataset.match);
}

function bindSignaturePad() {
  ['tigers', 'firmas'].forEach(team => {
    const canvas = signatureCanvas(team);
    const ctx = canvas.getContext('2d');
    let drawing = false;

    function point(event) {
      const rect = canvas.getBoundingClientRect();
      const source = event.touches?.[0] || event;
      return {
        x: (source.clientX - rect.left) * (canvas.width / rect.width),
        y: (source.clientY - rect.top) * (canvas.height / rect.height)
      };
    }

    function start(event) {
      drawing = true;
      signatureInk[team] = true;
      document.getElementById('signatureError').hidden = true;
      const p = point(event);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      event.preventDefault();
    }

    function move(event) {
      if (!drawing) return;
      const p = point(event);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#0d1726';
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      event.preventDefault();
    }

    function end() {
      drawing = false;
    }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
  });
}

function onRosterInput(event) {
  const input = event.target.closest('.roster-input');
  if (!input) return;
  const { roster, id, team } = input.dataset;
  const collection = roster === 'pairs' ? state.pairs : state.individuals;
  const item = collection.find(entry => String(entry.id) === id);
  if (!item) return;
  openPlayerPicker(input);
}

function positionPicker(input, picker) {
  const rect = input.getBoundingClientRect();
  picker.style.left = `${rect.left + window.scrollX}px`;
  picker.style.top = `${rect.bottom + window.scrollY + 4}px`;
  picker.style.width = `${rect.width}px`;
}

function openPlayerPicker(input) {
  const picker = document.getElementById('playerPicker');
  if (!picker) return;
  const { roster, id, team } = input.dataset;
  if (rosterItemIsLocked(roster, id)) {
    alert('Esta composicion ya tiene tarjetas iniciadas o finalizadas y no se puede modificar.');
    return;
  }
  const collection = roster === 'pairs' ? state.pairs : state.individuals;
  const item = collection.find(entry => String(entry.id) === id);
  const available = availablePlayersForRoster(roster, id, team, item?.[team] || '', input.value);
  positionPicker(input, picker);
  picker.hidden = false;
  picker.dataset.targetRoster = roster;
  picker.dataset.targetId = id;
  picker.dataset.targetTeam = team;
  picker.innerHTML = available.length
    ? available.map(player => `<button type="button" data-player-name="${escapeHtml(player.name)}">${escapeHtml(player.name)}</button>`).join('')
    : '<span class="player-picker-empty">Sin jugadores disponibles</span>';
}

function closePlayerPicker() {
  const picker = document.getElementById('playerPicker');
  if (picker) picker.hidden = true;
}

function chooseRosterPlayer(event) {
  const button = event.target.closest('#playerPicker button');
  if (!button) return;
  const picker = document.getElementById('playerPicker');
  const { targetRoster, targetId, targetTeam } = picker.dataset;
  if (!canWriteOnline()) {
    warnOfflineWrite();
    closePlayerPicker();
    renderRoster();
    return;
  }
  if (rosterItemIsLocked(targetRoster, targetId)) {
    alert('Esta composicion ya tiene tarjetas iniciadas o finalizadas y no se puede modificar.');
    closePlayerPicker();
    renderRoster();
    return;
  }
  const collection = targetRoster === 'pairs' ? state.pairs : state.individuals;
  const item = collection.find(entry => String(entry.id) === String(targetId));
  if (!item) return;
  const selected = parseSelection(item[targetTeam]);
  const playerName = button.dataset.playerName;
  item[targetTeam] = targetRoster === 'pairs'
    ? [...selected, playerName].slice(0, 2).join(' & ')
    : playerName;
  saveState();
  closePlayerPicker();
  renderTeamOptions();
  renderResultsTable();
  renderCards();
  renderRoster();
}

function removeRosterPlayer(event) {
  const button = event.target.closest('.roster-remove');
  if (!button) return;
  const { roster, id, team, name } = button.dataset;
  if (!canWriteOnline()) {
    warnOfflineWrite();
    closePlayerPicker();
    renderRoster();
    return;
  }
  if (rosterItemIsLocked(roster, id)) {
    alert('Esta composicion ya tiene tarjetas iniciadas o finalizadas y no se puede modificar.');
    closePlayerPicker();
    renderRoster();
    return;
  }
  const collection = roster === 'pairs' ? state.pairs : state.individuals;
  const item = collection.find(entry => String(entry.id) === String(id));
  if (!item) return;
  item[team] = parseSelection(item[team])
    .filter(playerName => normalizeSearch(playerName) !== normalizeSearch(name))
    .join(' & ');
  saveState();
  closePlayerPicker();
  renderTeamOptions();
  renderResultsTable();
  renderCards();
  renderRoster();
}

function onPlayerInput(event) {
  const input = event.target.closest('.player-input');
  if (!input) return;
  if (!canWriteOnline()) {
    warnOfflineWrite();
    renderRoster();
    return;
  }
  const { player, field } = input.dataset;
  const item = state.players.find(entry => String(entry.id) === String(player));
  if (!item) return;
  item[field] = field === 'isAdmin' ? toBoolean(input.value) : input.value;
  saveState();
  renderTeamOptions();
  renderResultsTable();
  renderCards();
}

function togglePlayerPassword(event) {
  const button = event.target.closest('.password-toggle');
  if (!button) return;
  const field = button.closest('.password-field');
  const input = field?.querySelector('.password-input');
  if (!input) return;
  const shouldHide = input.type === 'text';
  input.type = shouldHide ? 'password' : 'text';
  button.classList.toggle('is-visible', !shouldHide);
  button.setAttribute('aria-label', shouldHide ? 'Mostrar contrasena' : 'Ocultar contrasena');
}

function addPlayer() {
  if (!canWriteOnline()) {
    warnOfflineWrite();
    return;
  }
  const nextId = Math.max(0, ...state.players.map(player => Number(player.id) || 0)) + 1;
  state.players.push({
    id: nextId,
    team: 'Tigers',
    name: '',
    username: '',
    password: '',
    isAdmin: false
  });
  saveState();
  renderRoster();
}

function matchHasRegisteredScores(match) {
  const rows = state.values[match.id];
  if (!rows) return false;
  return ['tigers', 'firmas'].some(team =>
    Array.isArray(rows[team]) && rows[team].some(value => String(value ?? '').trim())
  );
}

function matchLocksRosterItem(match) {
  return matchHasRegisteredScores(match) || isFinalized(match.id);
}

function pairIsLocked(pairId) {
  return state.matches.some(match =>
    match.pairId === pairId && matchLocksRosterItem(match)
  );
}

function individualIsLocked(individualId) {
  return state.matches.some(match =>
    match.individualId === individualId && matchLocksRosterItem(match)
  );
}

function rosterItemIsLocked(roster, id) {
  return roster === 'pairs' ? pairIsLocked(Number(id)) : individualIsLocked(Number(id));
}

function rosterItemHasNames(item) {
  return Boolean(String(item.tigers || '').trim() || String(item.firmas || '').trim());
}

function resetUnlockedRosterItems(label, items, isLocked) {
  const locked = items.filter(item => isLocked(item.id));
  const cleanable = items.filter(item => !isLocked(item.id) && rosterItemHasNames(item));
  const empty = items.length - locked.length - cleanable.length;
  if (!cleanable.length) {
    alert(`No hay ${label} configuradas sin registros para reiniciar. Se conservan ${locked.length} con tarjetas iniciadas o finalizadas. Hay ${empty} vacias.`);
    return false;
  }

  const message = `Se limpiaran ${cleanable.length} ${label} configuradas sin registros. Se conservaran ${locked.length} con tarjetas iniciadas o finalizadas. Hay ${empty} vacias.`;
  if (!confirm(message)) return false;

  cleanable.forEach(item => {
    item.tigers = '';
    item.firmas = '';
  });
  return true;
}

function clearPairs() {
  if (!canWriteOnline()) {
    warnOfflineWrite();
    return;
  }
  if (!resetUnlockedRosterItems('parejas', state.pairs, pairIsLocked)) return;
  saveState();
  closePlayerPicker();
  renderTeamOptions();
  renderResultsTable();
  renderCards();
  renderRoster();
}

function clearIndividuals() {
  if (!canWriteOnline()) {
    warnOfflineWrite();
    return;
  }
  if (!resetUnlockedRosterItems('individuales', state.individuals, individualIsLocked)) return;
  saveState();
  closePlayerPicker();
  renderTeamOptions();
  renderResultsTable();
  renderCards();
  renderRoster();
}

function setActiveTab(tabName) {
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === tabName));
  document.body.dataset.activeTab = tabName;
}

function exportJson() {
  const blob = new Blob([JSON.stringify({ values: state.values }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ryder-2026-resultados.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.values) throw new Error('El JSON no contiene la propiedad values');
      state.values = data.values;
      ensureStateShape();
      saveState();
      renderAll();
    } catch (error) {
      alert('No fue posible importar el archivo JSON.');
      console.error(error);
    }
  };
  reader.readAsText(file);
}

function openResetModal() {
  if (!isAdminUser()) return;
  const modal = document.getElementById('resetModal');
  const input = document.getElementById('resetPassword');
  document.getElementById('resetError').hidden = true;
  input.value = '';
  modal.hidden = false;
  input.focus();
}

function closeResetModal() {
  document.getElementById('resetModal').hidden = true;
}

function submitLogin(event) {
  event.preventDefault();
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPassword').value;
  const user = findUser(username);
  if (!user || String(user.password || '') !== password) {
    document.getElementById('loginError').hidden = false;
    document.getElementById('loginPassword').select();
    return;
  }
  saveSession(userKey(user));
  document.getElementById('loginError').hidden = true;
  document.getElementById('loginPassword').value = '';
  setActiveTab(defaultTab());
  applyAccessControl();
  renderAll();
}

function logout() {
  clearSession();
  setActiveTab('resultados');
  applyAccessControl();
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').hidden = true;
}

function resetAll() {
  if (!isAdminUser()) return;
  if (!canWriteOnline()) {
    warnOfflineWrite();
    return;
  }
  if (document.getElementById('resetPassword').value !== '1130') {
    document.getElementById('resetError').hidden = false;
    document.getElementById('resetPassword').select();
    return;
  }
  state.values = {};
  state.finalizations = {};
  ensureStateShape();
  saveState({ sync: false });
  window.RyderSync?.reset(currentUsername());
  renderAll();
  closeResetModal();
}

function toggleCardsEditing(event) {
  if (!event.target.closest('#cardsEditingToggle')) return;
  if (!isAdminUser()) {
    renderSettingsControls();
    return;
  }
  if (!canWriteOnline()) {
    warnOfflineWrite();
    renderSettingsControls();
    return;
  }
  state.settings.cardsEditingEnabled = event.target.checked;
  saveState();
  renderAll();
}

function bindEvents() {
  document.addEventListener('input', onInput);
  document.addEventListener('click', onCardAction);
  document.addEventListener('input', onRosterInput);
  document.addEventListener('input', onPlayerInput);
  document.addEventListener('change', onPlayerInput);
  document.addEventListener('click', togglePlayerPassword);
  document.addEventListener('change', toggleCardsEditing);
  document.addEventListener('click', chooseRosterPlayer);
  document.addEventListener('click', removeRosterPlayer);
  document.addEventListener('click', event => {
    const input = event.target.closest?.('.roster-input');
    if (input) openPlayerPicker(input);
  });
  document.addEventListener('focusin', event => {
    const input = event.target.closest?.('.roster-input');
    if (input) openPlayerPicker(input);
  });
  document.addEventListener('click', event => {
    if (event.target.closest('.roster-input') || event.target.closest('#playerPicker')) return;
    closePlayerPicker();
  });
  document.querySelectorAll('[data-search]').forEach(input => input.addEventListener('input', event => {
    if (event.target.dataset.search === 'resultados') {
      state.resultsTeamSearch = event.target.value;
      renderResultsTable();
      return;
    }
    state.cardsTeamSearch = event.target.value;
    renderCards();
  }));
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    if (!canAccessTab(tab.dataset.tab)) return;
    setActiveTab(tab.dataset.tab);
  }));
  document.querySelectorAll('[data-filter-group]').forEach(group => group.addEventListener('click', event => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const filter = chip.dataset.filter;
    group.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
    if (group.dataset.filterGroup === 'resultados') {
      state.resultsFilter = filter;
      renderResultsTable();
      return;
    }
    state.cardsFilter = filter;
    renderCards();
  }));
  document.getElementById('resultsStatusFilter').addEventListener('change', event => {
    state.resultsStatusFilter = event.target.value;
    renderResultsTable();
  });
  document.getElementById('cardsStatusFilter').addEventListener('change', event => {
    state.cardsStatusFilter = event.target.value;
    renderCards();
  });
  document.getElementById('btnReset').addEventListener('click', openResetModal);
  document.getElementById('btnLogout').addEventListener('click', logout);
  document.getElementById('loginForm').addEventListener('submit', submitLogin);
  document.getElementById('btnAddPlayer').addEventListener('click', addPlayer);
  document.getElementById('btnClearPairs').addEventListener('click', clearPairs);
  document.getElementById('btnClearIndividuals').addEventListener('click', clearIndividuals);
  document.getElementById('btnCancelReset').addEventListener('click', closeResetModal);
  document.getElementById('btnConfirmReset').addEventListener('click', resetAll);
  document.getElementById('btnClearSignature').addEventListener('click', clearAllSignatures);
  document.getElementById('btnCancelSignature').addEventListener('click', closeSignatureModal);
  document.getElementById('btnConfirmSignature').addEventListener('click', finalizeCurrentMatch);
  document.getElementById('btnCancelUnlock').addEventListener('click', closeUnlockModal);
  document.getElementById('btnCancelDownload').addEventListener('click', closeDownloadModal);
  document.getElementById('downloadImageLink').addEventListener('click', downloadCardImage);
  document.getElementById('btnConfirmUnlock').addEventListener('click', unlockCurrentMatch);
  document.getElementById('unlockUser').addEventListener('keydown', event => {
    if (event.key === 'Enter') document.getElementById('unlockPassword').focus();
    if (event.key === 'Escape') closeUnlockModal();
  });
  document.getElementById('unlockPassword').addEventListener('keydown', event => {
    if (event.key === 'Enter') unlockCurrentMatch();
    if (event.key === 'Escape') closeUnlockModal();
  });
  document.getElementById('resetPassword').addEventListener('keydown', event => {
    if (event.key === 'Enter') resetAll();
    if (event.key === 'Escape') closeResetModal();
  });
  window.addEventListener('ryder-sync-warning', handleSyncWarning);
}

loadState();
loadSession();
ensureStateShape();
bindEvents();
bindSignaturePad();
setActiveTab(defaultTab());
applyAccessControl();
renderAll();
window.RyderSync?.start({
  initialValues: stateSnapshot(),
  onState: applyRemoteState
});
