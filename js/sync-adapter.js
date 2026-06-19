(function () {
  const listeners = new Set();
  let socket = null;
  let connected = false;

  function notifyStatus(status) {
    document.documentElement.dataset.sync = status;
  }

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/sync`;
  }

  function send(message) {
    if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function rejectOffline() {
    notifyStatus('local');
    window.dispatchEvent(new CustomEvent('ryder-sync-warning', {
      detail: {
        message: 'Sin conexion con el servidor. No se guardaron cambios.'
      }
    }));
  }

  function sendMutation(message) {
    if (send(message)) return true;
    rejectOffline();
    return false;
  }

  function requestState() {
    send({ type: 'hello', values: {} });
  }

  function connect(initialValues) {
    if (!('WebSocket' in window)) {
      notifyStatus('local');
      return;
    }

    socket = new WebSocket(wsUrl());
    notifyStatus('connecting');

    socket.addEventListener('open', () => {
      connected = true;
      notifyStatus('online');
      send({ type: 'hello', values: initialValues || {} });
    });

    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'state') {
          listeners.forEach(listener => listener(message.values || {}));
        }
        if (message.type === 'finalize-rejected') {
          window.dispatchEvent(new CustomEvent('ryder-sync-warning', {
            detail: {
              message: message.message || 'Esta tarjeta ya fue finalizada.',
              values: message.values || {}
            }
          }));
          listeners.forEach(listener => listener(message.values || {}));
        }
      } catch (error) {
        console.warn('No fue posible procesar el estado sincronizado', error);
      }
    });

    socket.addEventListener('close', () => {
      connected = false;
      notifyStatus('local');
      window.setTimeout(() => connect(initialValues), 1500);
    });

    socket.addEventListener('error', () => {
      connected = false;
      notifyStatus('local');
    });
  }

  window.RyderSync = {
    start({ initialValues, onState }) {
      if (typeof onState === 'function') listeners.add(onState);
      connect(initialValues);
    },
    save(values, username = '') {
      return sendMutation({ type: 'set-state', values, username });
    },
    setHole(matchId, team, hole, value, username = '') {
      return sendMutation({ type: 'set-hole', matchId, team, hole, value, username });
    },
    finalize(matchId, values, finalization, username = '') {
      return sendMutation({ type: 'finalize-match', matchId, values, finalization, username });
    },
    unlock(matchId, values, username = '') {
      return sendMutation({ type: 'unlock-match', matchId, values, username });
    },
    reset(username = '') {
      return sendMutation({ type: 'reset', username });
    },
    refresh() {
      requestState();
    },
    isOnline() {
      return connected && socket?.readyState === WebSocket.OPEN;
    }
  };

  window.addEventListener('focus', requestState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestState();
  });
})();
