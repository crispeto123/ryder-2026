const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function loadTournamentData() {
  const context = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'data', 'matches.js'), 'utf8'),
    context,
    { filename: 'data/matches.js' }
  );
  return {
    matches: context.window.RYDER_MATCHES,
    players: context.window.RYDER_PLAYERS,
    systemUsers: context.window.RYDER_SYSTEM_USERS,
    pairs: context.window.RYDER_PAIRS,
    individuals: context.window.RYDER_INDIVIDUALS
  };
}

function loadScoring({ matches, players, systemUsers, pairs, individuals }) {
  const source = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
  const pureSource = source.split('\nloadState();')[0];
  const context = {
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    structuredClone: value => JSON.parse(JSON.stringify(value)),
    window: { RYDER_MATCHES: matches, RYDER_PLAYERS: players, RYDER_SYSTEM_USERS: systemUsers, RYDER_PAIRS: pairs, RYDER_INDIVIDUALS: individuals, location: { search: '' } },
    URLSearchParams
  };

  vm.runInNewContext(
    `${pureSource}
globalThis.__RyderTest = { state, ensureStateShape, calculateMatch, calculateTotals, holesForMatch, teamName, canEditMatch, filteredMatches, isFinalized, matchResultLabel, matchProgressLabel, winnerLabel, canFinalizeMatch, canAccessTab, pairIsLocked, individualIsLocked, rosterItemIsLocked };`,
    context,
    { filename: 'js/app.js' }
  );

  return context.__RyderTest;
}

function startedTieValues(holes) {
  return {
    tigers: Array(holes).fill('4'),
    firmas: Array(holes).fill('4')
  };
}

function winnerValues(holes, winner) {
  const tigers = Array(holes).fill('4');
  const firmas = Array(holes).fill('4');

  if (winner === 'tigers') {
    tigers[0] = '3';
    firmas[0] = '4';
  } else {
    tigers[0] = '4';
    firmas[0] = '3';
  }

  return { tigers, firmas };
}

function expectedPointsForMatch(match) {
  return match.type === 'Individual' ? 2 : 1;
}

function assertStartedMatchesUseConfiguredPointValue(scoring) {
  const totals = scoring.calculateTotals();

  for (const match of scoring.state.matches) {
    const calc = scoring.calculateMatch(match.id);
    if (!calc.hasStarted) continue;
    assert.strictEqual(
      calc.tigersPoints + calc.firmasPoints,
      expectedPointsForMatch(match),
      `${match.id} debe repartir exactamente ${expectedPointsForMatch(match)} punto(s) cuando ya comenzo`
    );
  }

  assert.strictEqual(totals.byType.Scramble.tigers + totals.byType.Scramble.firmas, 14);
  assert.strictEqual(totals.byType['Golpe a Golpe'].tigers + totals.byType['Golpe a Golpe'].firmas, 14);
  assert.strictEqual(totals.byType.Individual.tigers + totals.byType.Individual.firmas, 56);
}

const tournamentData = loadTournamentData();
const { matches, players, systemUsers, pairs, individuals } = tournamentData;
const counts = matches.reduce((acc, match) => {
  acc[match.type] = (acc[match.type] || 0) + 1;
  return acc;
}, {});

assert.deepStrictEqual(counts, {
  Scramble: 14,
  'Golpe a Golpe': 14,
  Individual: 28
});
assert.strictEqual(pairs.length, 14);
assert.strictEqual(individuals.length, 28);
assert.strictEqual(players[0].id, 1);
assert.strictEqual(players[0].team, 'Tigers');
assert.strictEqual(players[0].name, 'Ocampo');
assert.strictEqual(players[0].username, 'ocampo');
assert.strictEqual(players[0].password, '1130');
assert.strictEqual(players[0].isAdmin, true);
assert.strictEqual(systemUsers[0].name, 'TV');
assert.strictEqual(systemUsers[0].username, 'tv');
assert.strictEqual(systemUsers[0].access, 'tv');

for (let id = 1; id <= 14; id += 1) {
  assert.strictEqual(matches.find(match => match.id === `scramble-${String(id).padStart(2, '0')}`).pairId, id);
  assert.strictEqual(matches.find(match => match.id === `golpe-${String(id).padStart(2, '0')}`).pairId, id);
}

for (let id = 1; id <= 28; id += 1) {
  assert.strictEqual(matches.find(match => match.id === `individual-${String(id).padStart(2, '0')}`).individualId, id);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.values['scramble-01'] = {
    tigers: ['4', '4', '4', '4', '4', '4', '3', '3', ''],
    firmas: ['4', '4', '4', '4', '4', '4', '4', '4', '']
  };
  const closedPair = scoring.calculateMatch('scramble-01');
  assert.strictEqual(closedPair.closed.hole, 8);
  assert.strictEqual(closedPair.closed.lead, 2);
  assert.strictEqual(closedPair.closed.remaining, 1);
  assert.strictEqual(closedPair.closed.winner, 'Tigers');
  assert.strictEqual(scoring.matchResultLabel(scoring.state.matches.find(match => match.id === 'scramble-01'), closedPair), 'TIGERS 2&1');
  assert.strictEqual(scoring.winnerLabel(scoring.state.matches.find(match => match.id === 'scramble-01'), closedPair), 'FINALIZADO Gana Tigers');
  assert.strictEqual(scoring.matchProgressLabel(scoring.state.matches.find(match => match.id === 'scramble-01'), closedPair), 'FINALIZADO Gana Tigers');
  assert.strictEqual(scoring.canFinalizeMatch(scoring.state.matches.find(match => match.id === 'scramble-01'), closedPair), true);
  scoring.state.finalizations['scramble-01'] = { finalized: true, result: 'TIGERS 2&1' };
  assert.strictEqual(scoring.matchProgressLabel(scoring.state.matches.find(match => match.id === 'scramble-01'), closedPair), 'FINALIZADO Gana Tigers');
  assert.strictEqual(scoring.calculateTotals().finalized, 1);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.values['scramble-01'] = {
    tigers: ['', '', '', '', '', '', '3', '3', ''],
    firmas: ['', '', '', '', '', '', '4', '4', '']
  };
  const carouselPair = scoring.calculateMatch('scramble-01');
  assert.strictEqual(carouselPair.played, 2);
  assert.strictEqual(carouselPair.difference, 2);
  assert.strictEqual(carouselPair.closed, null);
  assert.strictEqual(scoring.matchResultLabel(scoring.state.matches.find(match => match.id === 'scramble-01'), carouselPair), 'TIGERS 2UP');
  assert.strictEqual(scoring.matchProgressLabel(scoring.state.matches.find(match => match.id === 'scramble-01'), carouselPair), 'Hoyo 2');
  assert.strictEqual(scoring.canFinalizeMatch(scoring.state.matches.find(match => match.id === 'scramble-01'), carouselPair), false);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.values['individual-01'] = {
    tigers: ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '3', '3', '3', '3'],
    firmas: ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '4', '4', '4', '4']
  };
  const carouselIndividual = scoring.calculateMatch('individual-01');
  assert.strictEqual(carouselIndividual.played, 4);
  assert.strictEqual(carouselIndividual.difference, 4);
  assert.strictEqual(carouselIndividual.closed, null);
  assert.strictEqual(scoring.matchResultLabel(scoring.state.matches.find(match => match.id === 'individual-01'), carouselIndividual), 'TIGERS 4UP');
  assert.strictEqual(scoring.matchProgressLabel(scoring.state.matches.find(match => match.id === 'individual-01'), carouselIndividual), 'Hoyo 4');
  assert.strictEqual(scoring.canFinalizeMatch(scoring.state.matches.find(match => match.id === 'individual-01'), carouselIndividual), false);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.values['scramble-01'] = {
    tigers: ['4', '', '', '', '', '', '', '', ''],
    firmas: ['5', '', '', '', '', '', '', '', '']
  };
  scoring.state.finalizations['golpe-01'] = { finalized: true, result: 'FINALIZADO Gana Tigers' };

  scoring.state.resultsStatusFilter = 'Sin iniciar';
  assert.strictEqual(scoring.filteredMatches('resultados').some(match => match.id === 'scramble-01'), false);
  assert.strictEqual(scoring.filteredMatches('resultados').some(match => match.id === 'individual-01'), true);

  scoring.state.resultsStatusFilter = 'En el campo';
  assert.deepStrictEqual(scoring.filteredMatches('resultados').map(match => match.id), ['scramble-01']);

  scoring.state.resultsStatusFilter = 'Finalizados';
  assert.deepStrictEqual(scoring.filteredMatches('resultados').map(match => match.id), ['golpe-01']);

  scoring.state.cardsStatusFilter = 'Sin iniciar';
  assert.strictEqual(scoring.filteredMatches('tarjetas').some(match => match.id === 'scramble-01'), false);
  assert.strictEqual(scoring.filteredMatches('tarjetas').some(match => match.id === 'individual-01'), true);

  scoring.state.cardsStatusFilter = 'En el campo';
  assert.deepStrictEqual(scoring.filteredMatches('tarjetas').map(match => match.id), ['scramble-01']);

  scoring.state.cardsStatusFilter = 'Finalizados';
  assert.deepStrictEqual(scoring.filteredMatches('tarjetas').map(match => match.id), ['golpe-01']);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  assert.strictEqual(scoring.matchProgressLabel(scoring.state.matches.find(match => match.id === 'scramble-01')), 'Sin iniciar');
  scoring.state.values['scramble-01'] = {
    tigers: ['4', '4', '4', '', '', '', '', '', ''],
    firmas: ['4', '5', '4', '', '', '', '', '', '']
  };
  assert.strictEqual(scoring.matchProgressLabel(scoring.state.matches.find(match => match.id === 'scramble-01')), 'Hoyo 3');
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.values['individual-01'] = {
    tigers: ['3', '3', '3', '3', '3', '3', '3', '3', '3', '3', '3', '', '', '', '', '', '', ''],
    firmas: ['4', '4', '4', '4', '4', '4', '4', '4', '4', '4', '4', '', '', '', '', '', '', '']
  };
  const closedIndividual = scoring.calculateMatch('individual-01');
  assert.strictEqual(closedIndividual.closed.hole, 10);
  assert.strictEqual(closedIndividual.closed.lead, 10);
  assert.strictEqual(closedIndividual.closed.remaining, 8);
  assert.strictEqual(closedIndividual.closed.winner, 'Tigers');
  assert.strictEqual(scoring.matchResultLabel(scoring.state.matches.find(match => match.id === 'individual-01'), closedIndividual), 'TIGERS 10&8');
  assert.strictEqual(scoring.canFinalizeMatch(scoring.state.matches.find(match => match.id === 'individual-01'), closedIndividual), true);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.values['scramble-01'] = startedTieValues(9);
  const completeTie = scoring.calculateMatch('scramble-01');
  assert.strictEqual(completeTie.played, 9);
  assert.strictEqual(completeTie.closed, null);
  assert.strictEqual(scoring.canFinalizeMatch(scoring.state.matches.find(match => match.id === 'scramble-01'), completeTie), true);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.pairs[0].tigers = 'Equipo Compartido #1';

  assert.strictEqual(scoring.teamName(scoring.state.matches.find(match => match.id === 'scramble-01'), 'tigers'), 'Equipo Compartido #1');
  assert.strictEqual(scoring.teamName(scoring.state.matches.find(match => match.id === 'golpe-01'), 'tigers'), 'Equipo Compartido #1');
  assert.strictEqual(scoring.teamName(scoring.state.matches.find(match => match.id === 'individual-01'), 'tigers'), 'Jugador Tigers #1');
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.players.push({
    id: 2,
    team: 'Tigers',
    name: 'Jero',
    username: 'jero',
    password: '1234',
    isAdmin: 'False'
  });
  scoring.state.currentUser = 'jero';
  scoring.state.pairs[0].tigers = 'Jero & Ocampo';
  scoring.state.pairs[0].firmas = '';
  scoring.state.pairs[1].tigers = '';
  scoring.state.pairs[1].firmas = '';

  assert.strictEqual(scoring.canEditMatch(scoring.state.matches.find(match => match.id === 'scramble-01')), false);
  assert.strictEqual(scoring.canEditMatch(scoring.state.matches.find(match => match.id === 'golpe-01')), false);
  assert.strictEqual(scoring.canEditMatch(scoring.state.matches.find(match => match.id === 'scramble-02')), false);
  assert.strictEqual(scoring.canEditMatch(scoring.state.matches.find(match => match.id === 'individual-01')), false);

  scoring.state.players.push(
    { id: 3, team: 'Tigers', name: 'Farrio', username: 'farrio', password: '1234', isAdmin: false },
    { id: 4, team: 'Firmas', name: 'Rival Uno', username: 'rival1', password: '1234', isAdmin: false },
    { id: 5, team: 'Firmas', name: 'Rival Dos', username: 'rival2', password: '1234', isAdmin: false }
  );
  scoring.state.pairs[0].tigers = 'Jero & Farrio';
  scoring.state.pairs[0].firmas = 'Rival Uno & Rival Dos';

  assert.strictEqual(scoring.canEditMatch(scoring.state.matches.find(match => match.id === 'scramble-01')), true);
  assert.strictEqual(scoring.canEditMatch(scoring.state.matches.find(match => match.id === 'golpe-01')), true);
  assert.deepStrictEqual(scoring.filteredMatches('tarjetas').map(match => match.id), ['scramble-01', 'golpe-01']);
  scoring.state.finalizations['scramble-01'] = { finalized: true, result: 'TIGERS 2&1' };
  assert.strictEqual(scoring.isFinalized('scramble-01'), true);
  assert.strictEqual(scoring.matchResultLabel(scoring.state.matches.find(match => match.id === 'scramble-01')).startsWith('TIGERS'), false);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.players.push({
    id: 2,
    team: 'Tigers',
    name: 'Jero',
    username: 'jero',
    password: '1234',
    isAdmin: false
  });

  scoring.state.currentUser = 'ocampo';
  assert.strictEqual(scoring.canAccessTab('resultados'), true);
  assert.strictEqual(scoring.canAccessTab('resultados-tv'), true);
  assert.strictEqual(scoring.canAccessTab('tarjetas'), true);
  assert.strictEqual(scoring.canAccessTab('equipos'), true);
  scoring.state.pairs[0].tigers = '';
  scoring.state.pairs[0].firmas = '';
  assert.strictEqual(scoring.canEditMatch(scoring.state.matches.find(match => match.id === 'scramble-01')), false);

  scoring.state.currentUser = 'jero';
  assert.strictEqual(scoring.canAccessTab('resultados'), true);
  assert.strictEqual(scoring.canAccessTab('tarjetas'), true);
  assert.strictEqual(scoring.canAccessTab('resultados-tv'), false);
  assert.strictEqual(scoring.canAccessTab('equipos'), false);

  scoring.state.currentUser = 'tv';
  assert.strictEqual(scoring.canAccessTab('resultados-tv'), true);
  assert.strictEqual(scoring.canAccessTab('resultados'), false);
  assert.strictEqual(scoring.canAccessTab('tarjetas'), false);
  assert.strictEqual(scoring.canAccessTab('equipos'), false);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  const totals = scoring.calculateTotals();

  assert.strictEqual(totals.started, 0);
  assert.strictEqual(totals.finalized, 0);
  assert.strictEqual(totals.byType.Scramble.tigers + totals.byType.Scramble.firmas, 0);
  assert.strictEqual(totals.byType['Golpe a Golpe'].tigers + totals.byType['Golpe a Golpe'].firmas, 0);
  assert.strictEqual(totals.byType.Individual.tigers + totals.byType.Individual.firmas, 0);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  scoring.state.values['individual-01'] = startedTieValues(18);
  const tiedIndividual = scoring.calculateMatch('individual-01');
  assert.strictEqual(tiedIndividual.tigersPoints, 1);
  assert.strictEqual(tiedIndividual.firmasPoints, 1);

  scoring.state.values['individual-02'] = winnerValues(18, 'tigers');
  const wonIndividual = scoring.calculateMatch('individual-02');
  assert.strictEqual(wonIndividual.tigersPoints, 2);
  assert.strictEqual(wonIndividual.firmasPoints, 0);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();

  assert.strictEqual(scoring.pairIsLocked(1), false);
  assert.strictEqual(scoring.pairIsLocked(2), false);
  assert.strictEqual(scoring.individualIsLocked(1), false);
  assert.strictEqual(scoring.individualIsLocked(2), false);

  scoring.state.values['scramble-01'].tigers[0] = '3';
  assert.strictEqual(scoring.pairIsLocked(1), true);
  assert.strictEqual(scoring.rosterItemIsLocked('pairs', 1), true);
  assert.strictEqual(scoring.pairIsLocked(2), false);
  assert.strictEqual(scoring.individualIsLocked(1), false);

  scoring.state.finalizations['individual-01'] = { finalized: true, result: 'FINALIZADO Gana Tigers' };
  assert.strictEqual(scoring.individualIsLocked(1), true);
  assert.strictEqual(scoring.rosterItemIsLocked('individuals', 1), true);
  assert.strictEqual(scoring.individualIsLocked(2), false);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  for (const match of scoring.state.matches) {
    scoring.state.values[match.id] = startedTieValues(scoring.holesForMatch(match));
  }

  assert.strictEqual(scoring.calculateTotals().started, 56);
  assertStartedMatchesUseConfiguredPointValue(scoring);
}

{
  const scoring = loadScoring(tournamentData);
  scoring.ensureStateShape();
  for (const [index, match] of scoring.state.matches.entries()) {
    scoring.state.values[match.id] = winnerValues(
      scoring.holesForMatch(match),
      index % 2 === 0 ? 'tigers' : 'firmas'
    );
  }

  assert.strictEqual(scoring.calculateTotals().started, 56);
  assertStartedMatchesUseConfiguredPointValue(scoring);
}

console.log('OK scoring rules');
