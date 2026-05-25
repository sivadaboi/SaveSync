import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_HISTORY_LIMIT = 200;
const logHistory = [];
let wsBroadcastFn = null;

export function setBroadcastFn(fn) {
  wsBroadcastFn = fn;
}

export function log(type, message, meta = '') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  
  const record = {
    timestamp,
    type, // 'info' | 'success' | 'warn' | 'error' | 'event'
    message,
    meta
  };

  logHistory.push(record);
  if (logHistory.length > LOG_HISTORY_LIMIT) {
    logHistory.shift();
  }

  // Console output
  const consoleMsg = `[${timestamp}] [${type.toUpperCase()}] ${message}${meta ? ` — ${meta}` : ''}`;
  if (type === 'error') {
    console.error(consoleMsg);
  } else if (type === 'warn') {
    console.warn(consoleMsg);
  } else {
    console.log(consoleMsg);
  }

  // Broadcast to WebSockets
  if (wsBroadcastFn) {
    try {
      wsBroadcastFn('console-log', record);
    } catch (e) {
      console.error('[Logger] Failed to broadcast log:', e.message);
    }
  }
}

export function getHistory() {
  return logHistory;
}
