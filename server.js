const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const rooms = new Map();
const clientInfo = new Map();
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Quick match: players who press FIND MATCH are put in a public room. The match
// starts by itself when the room is full, or MATCH_WAIT_MS after 2+ players are in.
const MATCH_MIN_PLAYERS = 2;
const MATCH_MAX_PLAYERS = 4;
const MATCH_WAIT_MS = Number(process.env.MATCH_WAIT_MS || 6000);

function roomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(value) {
  const name = String(value || '').trim().replace(/[^\p{L}\p{N}_ .-]/gu, '').slice(0, 18);
  return name || 'Player';
}

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  const players = room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready }));
  const host_id = room.players.length ? room.players[0].id : '';
  for (const p of room.players) send(p.ws, { type: 'room_state', room: code, host_id, players });
}

function clearRoomTimer(room) {
  if (room && room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (room) clearRoomTimer(room);
  rooms.delete(code);
}

function leaveRoom(ws) {
  const info = clientInfo.get(ws);
  if (!info || !info.room) return;
  const code = info.room;
  const room = rooms.get(code);
  info.room = null;
  if (!room) return;
  const idx = room.players.findIndex(p => p.ws === ws);
  if (idx === -1) return;

  // A match that is already running keeps every seat (so pawn colours never change).
  // The player who left is simply skipped from now on.
  if (room.game.active && !room.game.game_over) {
    room.players[idx].left = true;
    room.players[idx].ws = null;
    send(ws, { type: 'left_room' });
    if (room.players.every(p => p.left)) return deleteRoom(code);
    checkGameOver(room);
    if (!room.game.game_over && room.game.turn_index === idx) {
      room.game.turn_index = nextActiveIndex(room, idx);
      room.game.dice = 0;
      room.game.phase = 'roll';
      const next = room.players[room.game.turn_index];
      for (const p of room.players) {
        send(p.ws, { type: 'turn_update', room: code, reason: 'player_left', message: 'A player left. Turn passed.', turn_index: room.game.turn_index, turn_player_id: next ? next.id : '' });
      }
    }
    broadcastGame(room);
    return;
  }

  room.players.splice(idx, 1);
  send(ws, { type: 'left_room' });
  if (room.players.length === 0) return deleteRoom(code);
  if (room.public && room.players.length < MATCH_MIN_PLAYERS) clearRoomTimer(room);
  broadcastRoom(code);
}

function newRoom(code, isPublic) {
  const room = { code, public: Boolean(isPublic), timer: null, players: [], createdAt: Date.now(), game: { active: false, turn_index: 0, dice: 0, phase: 'roll' } };
  rooms.set(code, room);
  return room;
}

function joinRoom(ws, code, name, create) {
  const normalized = String(code || '').toUpperCase();
  let room = rooms.get(normalized);
  if (!room) {
    // Typing a new 4-character code opens a private room for friends.
    room = newRoom(normalized, false);
    create = true;
  }
  if (room.game.active) return send(ws, { type: 'error', message: 'That match has already started.' });
  if (room.players.length >= 4) return send(ws, { type: 'error', message: 'Room is full (4 players maximum).' });
  leaveRoom(ws);
  const info = clientInfo.get(ws);
  const player = { id: info.id, name: cleanName(name), ready: false, ws };
  room.players.push(player);
  info.room = normalized;
  send(ws, { type: create ? 'room_created' : 'room_joined', room: normalized });
  broadcastRoom(normalized);
}

function startGame(room) {
  clearRoomTimer(room);
  const players = room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready }));
  room.game = { active: true, turn_index: 0, dice: 0, phase: 'roll', pawns: initialPawns(), finish_order: [], winner: '', game_over: false, total_moves: 0 };
  const host = room.players[0];
  for (const p of room.players) send(p.ws, { type: 'game_start', room: room.code, host_id: host.id, players, turn: 0, turn_index: 0, turn_player_id: host.id });
}

// FIND MATCH: join the fullest public room that is still waiting, or open a new one.
function findMatch(ws, name) {
  leaveRoom(ws);
  let room = null;
  for (const r of rooms.values()) {
    if (!r.public || r.game.active || r.players.length >= MATCH_MAX_PLAYERS) continue;
    if (!room || r.players.length > room.players.length) room = r;
  }
  if (!room) room = newRoom(roomCode(), true);
  const info = clientInfo.get(ws);
  room.players.push({ id: info.id, name: cleanName(name), ready: true, ws });
  info.room = room.code;
  send(ws, { type: 'room_created', room: room.code, matchmaking: true });
  broadcastRoom(room.code);
  if (room.players.length >= MATCH_MAX_PLAYERS) {
    for (const p of room.players) p.ready = true;
    startGame(room);
  } else if (room.players.length >= MATCH_MIN_PLAYERS && !room.timer) {
    room.timer = setTimeout(() => {
      room.timer = null;
      if (rooms.get(room.code) !== room || room.game.active || room.players.length < MATCH_MIN_PLAYERS) return;
      for (const p of room.players) p.ready = true;
      startGame(room);
    }, MATCH_WAIT_MS);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const searching = [...rooms.values()].filter(r => r.public && !r.game.active).reduce((n, r) => n + r.players.length, 0);
    res.end(JSON.stringify({ ok: true, service: 'afri-ludo-online', rooms: rooms.size, searching }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Afri Ludo online server is running.\n');
});

const COLOR_ORDER = ['yellow', 'green', 'blue', 'red'];
const START_INDEX = { yellow: 0, green: 13, blue: 26, red: 39 };
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
function initialPawns(){ const p={}; for(const c of COLOR_ORDER) p[c]=[-1,-1,-1,-1]; return p; }
function absCell(color, progress){ return (START_INDEX[color] + progress) % 52; }
function movableFor(room, slot){ const color=COLOR_ORDER[slot]; const d=room.game.dice; const out=[]; const arr=room.game.pawns[color]; for(let i=0;i<arr.length;i++){ const pr=arr[i]; if(pr===-1){ if(d===6) out.push(i); } else if(pr+d<=56) out.push(i); } return out; }
function makeState(room){ const tp=room.players[room.game.turn_index]; return {type:'game_state',room:room.code,players:room.players.map(p=>({id:p.id,name:p.name,ready:p.ready,left:Boolean(p.left)})),turn_index:room.game.turn_index,turn_player_id:tp?tp.id:'',dice:room.game.dice,phase:room.game.phase,pawns:room.game.pawns,movable_pawns:room.game.phase==='move'?movableFor(room,room.game.turn_index):[],finish_order:room.game.finish_order,winner:room.game.winner,game_over:room.game.game_over,total_moves:room.game.total_moves}; }
function broadcastGame(room){ for(const p of room.players) send(p.ws, makeState(room)); }
function nextActiveIndex(room, from){ const n=room.players.length; for(let step=1; step<=n; step++){ const i=(from+step)%n; if(!room.players[i].left && !room.game.finish_order.includes(COLOR_ORDER[i])) return i; } return from; }
function checkGameOver(room){ const g=room.game; if(!g.active||g.game_over) return; const remaining=[]; for(let i=0;i<room.players.length;i++){ if(!room.players[i].left && !g.finish_order.includes(COLOR_ORDER[i])) remaining.push(i); } if(remaining.length>1) return; for(const i of remaining) g.finish_order.push(COLOR_ORDER[i]); for(let i=0;i<room.players.length;i++){ if(!g.finish_order.includes(COLOR_ORDER[i])) g.finish_order.push(COLOR_ORDER[i]); } if(!g.winner) g.winner=g.finish_order[0]; g.game_over=true; g.phase='game_over'; }
function applyMove(room, slot, idx){ const color=COLOR_ORDER[slot], arr=room.game.pawns[color], d=room.game.dice; if(idx<0||idx>=4) return [false,'Invalid pawn.']; if(!movableFor(room,slot).includes(idx)) return [false,'That pawn cannot move.']; const cur=arr[idx]; const next=cur===-1?0:cur+d; arr[idx]=next; let captured=false; if(next<=50){ const abs=absCell(color,next); if(!SAFE.has(abs)){ for(let j=0;j<Math.min(room.players.length,COLOR_ORDER.length);j++){ if(j===slot)continue; const oc=COLOR_ORDER[j]; for(let k=0;k<4;k++){ const op=room.game.pawns[oc][k]; if(op>=0&&op<=50&&absCell(oc,op)===abs){room.game.pawns[oc][k]=-1; captured=true;} } } } } const allHome=arr.every(v=>v===56); if(allHome&&!room.game.finish_order.includes(color)){ room.game.finish_order.push(color); if(room.game.finish_order.length===1)room.game.winner=color; checkGameOver(room); } room.game.total_moves++; const extra=d===6||captured||next===56; const justFinished=allHome; if(!room.game.game_over){ if(!extra||justFinished) room.game.turn_index=nextActiveIndex(room,slot); room.game.dice=0; room.game.phase='roll'; } return [true,'']; }
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  if (pathname !== '/') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const id = crypto.randomUUID();
  clientInfo.set(ws, { id, room: null });
  send(ws, { type: 'welcome', player_id: id, protocol: 1 });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid JSON.' }); }
    const info = clientInfo.get(ws);
    if (!info) return;
    switch (msg.type) {
      case 'create_room': {
        const code = roomCode();
        joinRoom(ws, code, msg.name, true);
        break;
      }
      case 'find_match':
        findMatch(ws, msg.name);
        break;
      case 'join_room':
        joinRoom(ws, msg.room, msg.name, false);
        break;
      case 'ready': {
        if (!info.room) return send(ws, { type: 'error', message: 'Join a room first.' });
        const room = rooms.get(info.room);
        const player = room?.players.find(p => p.ws === ws);
        if (!player) return;
        player.ready = Boolean(msg.ready);
        broadcastRoom(info.room);
        break;
      }
      case 'start_game': {
        if (!info.room) return send(ws, { type: 'error', message: 'Join a room first.' });
        const room = rooms.get(info.room);
        const host = room?.players[0];
        if (!host || host.ws !== ws) return send(ws, { type: 'error', message: 'Only the room host can start the game.' });
        if (!room || room.players.length < 2) return send(ws, { type: 'error', message: 'At least 2 players are required.' });
        if (room.players.some(p => !p.ready)) return send(ws, { type: 'error', message: 'All players must be ready.' });
        startGame(room);
        break;
      }
      case 'roll_dice': {
        if (!info.room) return send(ws, { type: 'error', message: 'Join a room first.' });
        const room = rooms.get(info.room);
        const playerIndex = room?.players.findIndex(p => p.ws === ws) ?? -1;
        if (!room?.game?.active) return send(ws, { type:'error', message:'The game has not started yet.' });
        if (playerIndex !== room.game.turn_index) return send(ws, { type:'error', message:'It is not your turn.' });
        if (room.game.phase !== 'roll') return send(ws, { type:'error', message:'Finish the current move before rolling again.' });
        const dice=crypto.randomInt(1,7); room.game.dice=dice; const options=movableFor(room,playerIndex);
        console.log(`[roll] room=${info.room} slot=${playerIndex} dice=${dice} pawns=${JSON.stringify(room.game.pawns[COLOR_ORDER[playerIndex]])} options=${JSON.stringify(options)}`);
        for(const p of room.players) send(p.ws,{type:'dice_result',room:info.room,turn_index:playerIndex,turn_player_id:room.players[playerIndex].id,dice,movable_pawns:options});
        if(options.length===0){
          const keepTurn = dice === 6;
          const nextIndex = keepTurn ? playerIndex : nextActiveIndex(room,playerIndex);
          room.game.turn_index=nextIndex;
          room.game.dice=0;
          room.game.phase='roll';
          const nextPlayer=room.players[nextIndex];
          for(const p of room.players){
            send(p.ws,{type:'turn_update',room:info.room,reason: keepTurn ? 'no_legal_move_six' : 'no_legal_move',message: keepTurn ? 'No legal move. Roll again.' : 'No legal move. Turn passed.',turn_index:nextIndex,turn_player_id:nextPlayer?nextPlayer.id:''});
          }
          broadcastGame(room);
        } else { room.game.phase='move'; }
        break;
      }
      case 'move_pawn': {
        if (!info.room) return send(ws,{type:'error',message:'Join a room first.'});
        const room=rooms.get(info.room); const playerIndex=room?.players.findIndex(p=>p.ws===ws) ?? -1;
        console.log(`[move_pawn] room=${info.room} playerIndex=${playerIndex} pawn_index=${msg.pawn_index} game_active=${room?.game?.active} phase=${room?.game?.phase} turn_index=${room?.game?.turn_index}`);
        if(!room?.game?.active||room.game.game_over) return send(ws,{type:'error',message:'Game is not active.'});
        if(playerIndex!==room.game.turn_index) return send(ws,{type:'error',message:'It is not your turn.'});
        if(room.game.phase!=='move') return send(ws,{type:'error',message:'Roll the dice first.'});
        const [ok,errMsg]=applyMove(room,playerIndex,Number(msg.pawn_index));
        console.log(`[move_pawn result] ok=${ok} errMsg=${errMsg} pawns_after=${JSON.stringify(room.game.pawns)} turn_index_after=${room.game.turn_index} phase_after=${room.game.phase}`);
        if(!ok) return send(ws,{type:'error',message:errMsg});
        broadcastGame(room); break;
      }
      case 'request_state': {
        // Lets a client recover if it ever misses a broadcast (brief drop,
        // reconnect, or just joining mid-match) instead of staying stuck
        // with no way to see the current turn/board state.
        if (!info.room) return send(ws, { type: 'error', message: 'Join a room first.' });
        const room = rooms.get(info.room);
        if (!room?.game?.active) return send(ws, { type: 'error', message: 'The game has not started yet.' });
        send(ws, makeState(room));
        break;
      }
      case 'leave_room':
        leaveRoom(ws);
        break;
      default:
        send(ws, { type: 'error', message: `Unknown message: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    clientInfo.delete(ws);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Afri Ludo online server listening on port ${PORT}`);
});
