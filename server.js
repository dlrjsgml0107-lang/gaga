'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingTimeout: 20_000,
  pingInterval: 25_000,
});

const PORT = Number(process.env.PORT) || 3000;
const MAX_MEMBERS = 4;
const rooms = new Map();

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function cleanRoomId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);
}

function cleanNickname(value) {
  return String(value || '익명').trim().slice(0, 16) || '익명';
}

function publicMembers(room) {
  return [...room.members.entries()].map(([id, member]) => ({
    id,
    nickname: member.nickname,
    role: member.role,
  }));
}

function emitPresence(roomId, room) {
  io.to(roomId).emit('presence', {
    count: room.members.size,
    max: MAX_MEMBERS,
    members: publicMembers(room),
    hasHost: Boolean(room.hostId),
  });
}

io.on('connection', (socket) => {
  socket.on('join-room', (payload = {}, reply = () => {}) => {
    const roomId = cleanRoomId(payload.roomId);
    const nickname = cleanNickname(payload.nickname);
    let requestedRole = payload.role === 'host' ? 'host' : 'viewer';

    if (!roomId) return reply({ ok: false, message: '방 코드가 올바르지 않아.' });
    if (socket.data.roomId) return reply({ ok: false, message: '이미 방에 들어와 있어.' });

    const room = rooms.get(roomId) || { hostId: null, members: new Map() };
    if (room.members.size >= MAX_MEMBERS) {
      return reply({ ok: false, message: '이 방은 이미 4명이 꽉 찼어.' });
    }

    if (requestedRole === 'host' && room.hostId) requestedRole = 'viewer';
    if (!room.hostId && requestedRole === 'viewer') {
      return reply({ ok: false, message: '방장이 아직 방을 만들지 않았어.' });
    }

    const role = requestedRole;
    if (role === 'host') room.hostId = socket.id;

    room.members.set(socket.id, { nickname, role });
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;
    socket.data.role = role;

    reply({ ok: true, role, memberCount: room.members.size, max: MAX_MEMBERS });
    emitPresence(roomId, room);
    socket.to(roomId).emit('system-message', { text: `${nickname}님이 입장했어.` });

    if (role === 'viewer' && room.hostId) {
      io.to(room.hostId).emit('viewer-ready', {
        viewerId: socket.id,
        nickname,
      });
    }
  });

  socket.on('signal', ({ target, data } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !target || !data) return;
    const room = rooms.get(roomId);
    if (!room || !room.members.has(target)) return;
    io.to(target).emit('signal', { from: socket.id, data });
  });

  socket.on('chat-message', ({ text } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const cleanText = String(text || '').trim().slice(0, 500);
    if (!cleanText) return;
    io.to(roomId).emit('chat-message', {
      nickname: socket.data.nickname || '익명',
      text: cleanText,
      at: Date.now(),
    });
  });

  socket.on('host-sharing', ({ sharing } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || socket.data.role !== 'host') return;
    socket.to(roomId).emit('host-sharing', { sharing: Boolean(sharing) });
  });

  socket.on('request-stream', () => {
    const roomId = socket.data.roomId;
    if (!roomId || socket.data.role !== 'viewer') return;
    const room = rooms.get(roomId);
    if (!room?.hostId) return;
    io.to(room.hostId).emit('viewer-ready', {
      viewerId: socket.id,
      nickname: socket.data.nickname || '시청자',
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const member = room.members.get(socket.id);
    room.members.delete(socket.id);
    const wasHost = room.hostId === socket.id;
    if (wasHost) room.hostId = null;

    if (room.members.size === 0 || wasHost) {
      if (wasHost) {
        io.to(roomId).emit('host-left');
        for (const memberId of room.members.keys()) {
          const memberSocket = io.sockets.sockets.get(memberId);
          if (memberSocket) memberSocket.leave(roomId);
        }
      }
      rooms.delete(roomId);
      return;
    }

    rooms.set(roomId, room);
    emitPresence(roomId, room);
    io.to(roomId).emit('peer-left', {
      id: socket.id,
      nickname: member?.nickname || '한 명',
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`같이보자 실행 중: http://localhost:${PORT}`);
});
