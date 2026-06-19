// Archivo editable. Cambia nombres en RYDER_PLAYERS.
// Los nombres de parejas e individuales se arman desde la lista maestra de jugadores.
// Scramble y Golpe a Golpe comparten las mismas 14 parejas por pairId.
// Individual usa jugadores independientes por individualId.
window.RYDER_PLAYERS = [
  {
    id: 1,
    team: 'Tigers',
    name: 'Ocampo',
    username: 'ocampo',
    password: '1130',
    isAdmin: true
  }
];

window.RYDER_SYSTEM_USERS = [
  {
    name: 'TV',
    username: 'tv',
    password: 'tv',
    isAdmin: false,
    access: 'tv'
  }
];

window.RYDER_PAIRS = Array.from({ length: 14 }, (_, index) => {
  const number = index + 1;
  return {
    id: number,
    tigers: `Tigers Pareja #${number}`,
    firmas: `Firmas Pareja #${number}`
  };
});

window.RYDER_INDIVIDUALS = Array.from({ length: 28 }, (_, index) => {
  const number = index + 1;
  return {
    id: number,
    tigers: `Jugador Tigers #${number}`,
    firmas: `Jugador Firmas #${number}`
  };
});

window.RYDER_MATCHES = [
  ...window.RYDER_PAIRS.map(pair => ({
    id: `scramble-${String(pair.id).padStart(2, '0')}`,
    type: 'Scramble',
    title: `Scramble #${pair.id}`,
    pairId: pair.id
  })),
  ...window.RYDER_PAIRS.map(pair => ({
    id: `golpe-${String(pair.id).padStart(2, '0')}`,
    type: 'Golpe a Golpe',
    title: `Golpe a Golpe #${pair.id}`,
    pairId: pair.id
  })),
  ...window.RYDER_INDIVIDUALS.map(individual => ({
    id: `individual-${String(individual.id).padStart(2, '0')}`,
    type: 'Individual',
    title: `Individual #${individual.id}`,
    individualId: individual.id
  }))
];
