(function () {
  const listeners = new Set();
  let socket = null;
  let connected = false;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let offlineTimer = null;
  let reconnectAttempt = 0;
  let lastPongAt = 0;

  function notifyStatus(status) {
    document.documentElement.dataset.sync = status;
    window.dispatchEvent(new CustomEvent('ryder-sync-status', { detail: { status } }));
  }

  function clearOfflineTimer() {
    if (offlineTimer) window.clearTimeout(offlineTimer);
    offlineTimer = null;
  }

  function showOfflineAfterGrace() {
    clearOfflineTimer();
    notifyStatus('connecting');
    offlineTimer = window.setTimeout(() => {
      if (!connected) notifyStatus('local');
    }, 6500);
  }

  function scheduleReconnect(initialValues) {
    if (reconnectTimer) return;
    const delay = Math.min(8000, 1500 + (reconnectAttempt * 1000));
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect(initialValues);
    }, delay);
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

  function stopHeartbeat() {
    if (heartbeatTimer) window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    heartbeatTimer = window.setInterval(() => {
      if (!send({ type: 'ping', at: Date.now() })) return;
      if (Date.now() - lastPongAt > 45000) {
        connected = false;
        showOfflineAfterGrace();
        try { socket?.close(); } catch {}
      }
    }, 15000);
  }

  function connect(initialValues) {
    if (!('WebSocket' in window)) {
      notifyStatus('local');
      return;
    }
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;

    socket = new WebSocket(wsUrl());
    notifyStatus('connecting');

    socket.addEventListener('open', () => {
      connected = true;
      reconnectAttempt = 0;
      clearOfflineTimer();
      notifyStatus('online');
      startHeartbeat();
      send({ type: 'hello', values: initialValues || {} });
    });

    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'state') {
          listeners.forEach(listener => listener(message.values || {}));
        }
        if (message.type === 'pong') {
          lastPongAt = Date.now();
        }
        if (message.type === 'hole-saved') {
          window.dispatchEvent(new CustomEvent('ryder-hole-saved', { detail: message }));
        }
        if (message.type === 'hole-ignored') {
          window.dispatchEvent(new CustomEvent('ryder-hole-ignored', { detail: message }));
        }
        if (message.type === 'finalize-rejected' || message.type === 'sync-warning') {
          window.dispatchEvent(new CustomEvent('ryder-sync-warning', {
            detail: {
              matchId: message.matchId || '',
              message: message.message || 'No se pudo guardar el cambio.',
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
      socket = null;
      stopHeartbeat();
      showOfflineAfterGrace();
      scheduleReconnect(initialValues);
    });

    socket.addEventListener('error', () => {
      connected = false;
      stopHeartbeat();
      showOfflineAfterGrace();
      try { socket?.close(); } catch {}
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
    setHole(matchId, team, hole, value, username = '', meta = {}) {
      return sendMutation({ type: 'set-hole', matchId, team, hole, value, username, ...meta });
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
