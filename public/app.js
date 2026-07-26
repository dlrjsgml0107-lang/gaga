'use strict';

const socket = io();
const byId = (id) => document.getElementById(id);
const ids = ['lobby','room','stage','cinemaUi','chatOverlay','chatToggleBtn','nickname','roomCode','createBtn','joinBtn','copyBtn','roleText','status','people','members','video','videoBackdrop','emptyState','emptyTitle','emptyDesc','shareBtn','stopBtn','fullscreenBtn','messages','chatForm','chatInput','toast','installBtn','installDialog','closeInstallBtn','installInstructions','nativeInstallBtn'];
const el = Object.fromEntries(ids.map((id) => [id, byId(id)]));

let role = 'viewer';
let roomId = '';
let nickname = '';
let localStream = null;
let toastTimer = null;
let uiTimer = null;
let chatHidden = false;
let pseudoFullscreen = false;
let deferredInstallPrompt = null;
const peers = new Map();
const pendingCandidates = new Map();

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIosSafari() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function updateInstallUi() {
  const mobile = isMobileDevice();
  const standalone = isStandaloneApp();
  document.body.classList.toggle('standalone-app', standalone);
  el.installBtn?.classList.toggle('hidden', !mobile || standalone);
  if (standalone && el.fullscreenBtn) { const label = el.fullscreenBtn.querySelector('.dock-label'); if (label) label.textContent = '집중 모드'; }
}

function openInstallGuide() {
  if (!el.installDialog) return;
  const nativeAvailable = Boolean(deferredInstallPrompt);
  el.nativeInstallBtn?.classList.toggle('hidden', !nativeAvailable);
  const steps = el.installDialog.querySelector('.ios-steps');
  if (steps) steps.classList.toggle('hidden', nativeAvailable && !isIosSafari());
  if (el.installInstructions) {
    el.installInstructions.textContent = nativeAvailable && !isIosSafari()
      ? '설치하면 주소창 없이 독립된 앱 화면으로 열려.'
      : 'Safari의 공유 버튼을 누른 다음 ‘홈 화면에 추가’를 선택하면 주소창과 탭바 없이 앱처럼 볼 수 있어.';
  }
  if (typeof el.installDialog.showModal === 'function') el.installDialog.showModal();
  else el.installDialog.setAttribute('open', '');
}

async function installApp() {
  if (!deferredInstallPrompt) return openInstallGuide();
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => null);
  deferredInstallPrompt = null;
  updateInstallUi();
  el.installDialog?.close?.();
}

function setVideoStream(stream, muted = false) {
  el.video.srcObject = stream;
  el.video.muted = muted;
  if (el.videoBackdrop) {
    el.videoBackdrop.srcObject = stream;
    el.videoBackdrop.muted = true;
    el.videoBackdrop.play().catch(() => {});
  }
}

function clearVideoStream() {
  el.video.srcObject = null;
  if (el.videoBackdrop) el.videoBackdrop.srcObject = null;
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallUi();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallUi();
  showToast('같이보자 설치 완료');
});
window.matchMedia('(display-mode: standalone)').addEventListener?.('change', updateInstallUi);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('서비스 워커 등록 실패:', error)));
}

function updateViewportSize() {
  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight;
  const width = viewport?.width || window.innerWidth;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  document.documentElement.style.setProperty('--app-width', `${width}px`);
}
updateViewportSize();
window.addEventListener('resize', updateViewportSize);
window.visualViewport?.addEventListener('resize', updateViewportSize);
window.visualViewport?.addEventListener('scroll', updateViewportSize);

function showToast(text) {
  clearTimeout(toastTimer);
  el.toast.textContent = text;
  el.toast.classList.add('show');
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}


function showCinemaUi(duration = 3200) {
  if (!el.cinemaUi) return;
  el.cinemaUi.classList.add('visible');
  clearTimeout(uiTimer);
  if (document.activeElement === el.chatInput) return;
  uiTimer = setTimeout(() => {
    if (document.activeElement !== el.chatInput) el.cinemaUi.classList.remove('visible');
  }, duration);
}

function setChatHidden(hidden) {
  chatHidden = hidden;
  el.chatOverlay.classList.toggle('chat-hidden', hidden);
  el.chatToggleBtn.textContent = hidden ? '👁' : '💬';
  el.chatToggleBtn.title = hidden ? '채팅 보이기' : '채팅 숨기기';
  el.chatToggleBtn.setAttribute('aria-label', hidden ? '채팅 보이기' : '채팅 숨기기');
  showCinemaUi();
syncFullscreenButton();
}

function randomRoom() {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return `${values[0].toString(36)}${values[1].toString(36)}`.slice(0, 10);
}

function roomFromUrl() {
  return new URLSearchParams(location.search).get('room') || '';
}

function addMessage(name, text, system = false) {
  const item = document.createElement('div');
  item.className = system ? 'system' : 'message';
  if (system) {
    item.textContent = text;
  } else {
    const author = document.createElement('b');
    const body = document.createElement('span');
    author.textContent = name;
    body.textContent = text;
    item.append(author, body);
  }
  el.messages.appendChild(item);
  el.messages.scrollTop = el.messages.scrollHeight;
  if (!system) {
    setTimeout(() => item.classList.add('fading'), 8000);
    setTimeout(() => item.remove(), 9200);
  }
  showCinemaUi(5200);
}

function closePeer(id) {
  const pc = peers.get(id);
  if (pc) pc.close();
  peers.delete(id);
  pendingCandidates.delete(id);
}

function closeAllPeers() {
  for (const id of [...peers.keys()]) closePeer(id);
}

function updateViewerPlaceholder(title, desc) {
  el.emptyTitle.textContent = title;
  el.emptyDesc.textContent = desc;
  el.emptyState.classList.remove('hidden');
}

function enterRoom(asRole, rawId) {
  nickname = el.nickname.value.trim() || '익명';
  roomId = rawId.trim().toLowerCase();
  role = asRole;
  if (!roomId) return showToast('방 코드를 입력해줘');

  el.createBtn.disabled = true;
  el.joinBtn.disabled = true;
  socket.emit('join-room', { roomId, nickname, role }, (res) => {
    el.createBtn.disabled = false;
    el.joinBtn.disabled = false;
    if (!res?.ok) return showToast(res?.message || '방에 들어가지 못했어');

    role = res.role;
    el.lobby.classList.add('hidden');
    el.room.classList.remove('hidden');
    el.roleText.textContent = role === 'host' ? '방장' : '시청자';
    el.shareBtn.classList.toggle('hidden', role !== 'host');
    history.replaceState({}, '', `/?room=${encodeURIComponent(roomId)}`);

    if (role === 'host') {
      el.status.textContent = '화면 공유 준비';
      el.emptyTitle.textContent = '화면 공유를 시작해줘';
      el.emptyDesc.textContent = '영상이 재생되는 크롬 탭을 고르고 ‘탭 오디오 공유’를 켜줘.';
    } else {
      el.status.textContent = '방장 기다리는 중';
      updateViewerPlaceholder('방장 송출을 기다리는 중', '화면 공유가 시작되면 이곳에 자동으로 재생돼.');
    }
    addMessage('', `${nickname}님으로 입장했어.`, true);
    if (isStandaloneApp() && isMobileDevice()) lockLandscape();
  });
}

el.createBtn.addEventListener('click', () => enterRoom('host', randomRoom()));
el.joinBtn.addEventListener('click', () => enterRoom('viewer', el.roomCode.value));
el.installBtn?.addEventListener('click', openInstallGuide);
el.closeInstallBtn?.addEventListener('click', () => el.installDialog?.close?.());
el.nativeInstallBtn?.addEventListener('click', installApp);
el.installDialog?.addEventListener('click', (event) => { if (event.target === el.installDialog) el.installDialog.close(); });
el.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('초대 링크 복사 완료');
  } catch {
    showToast('주소창의 링크를 복사해줘');
  }
});
function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isMobileDevice() {
  return window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
}

function setPlayerMode(active) {
  document.body.classList.toggle('mobile-player-mode', active && isMobileDevice());
  syncFullscreenButton();
}

async function lockLandscape() {
  if (!isMobileDevice() || !screen.orientation?.lock) return false;
  try {
    await screen.orientation.lock('landscape');
    return true;
  } catch (error) {
    console.info('가로 방향 잠금을 사용할 수 없어 대체 플레이어를 사용해.', error);
    return false;
  }
}

function unlockOrientation() {
  try {
    screen.orientation?.unlock?.();
  } catch {}
}

function syncFullscreenButton() {
  const active = Boolean(fullscreenElement()) || pseudoFullscreen;
  const label = el.fullscreenBtn.querySelector('.dock-label');
  if (label) label.textContent = active ? '집중 모드 종료' : '집중 모드';
  else el.fullscreenBtn.textContent = active ? '집중 모드 종료' : '집중 모드';
  el.fullscreenBtn.setAttribute('aria-pressed', String(active));
  setPlayerMode(active);
}

async function exitFullscreen() {
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
}

function leavePlayerMode() {
  pseudoFullscreen = false;
  document.body.classList.remove('pseudo-fullscreen', 'mobile-player-mode');
  unlockOrientation();
  syncFullscreenButton();
}

async function enterFallbackPlayerMode() {
  pseudoFullscreen = true;
  document.body.classList.add('pseudo-fullscreen');
  setPlayerMode(true);
  await lockLandscape();
  showCinemaUi(5000);
}

async function toggleFullscreen() {
  const target = el.stage;

  if (isIosSafari() && isMobileDevice() && !isStandaloneApp()) {
    openInstallGuide();
    return;
  }

  try {
    if (fullscreenElement()) {
      await exitFullscreen();
      return;
    }

    if (pseudoFullscreen) {
      leavePlayerMode();
      return;
    }

    if (target.requestFullscreen) {
      await target.requestFullscreen({ navigationUI: 'hide' });
      setPlayerMode(true);
      await lockLandscape();
      return;
    }

    if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
      setPlayerMode(true);
      await lockLandscape();
      return;
    }

    await enterFallbackPlayerMode();
  } catch (error) {
    console.error('전체 화면 전환 실패:', error);
    await enterFallbackPlayerMode();
  }
}

el.fullscreenBtn.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(fullscreenElement());
  if (active) {
    setPlayerMode(true);
    lockLandscape();
  } else if (!pseudoFullscreen) {
    leavePlayerMode();
  }
});
document.addEventListener('webkitfullscreenchange', () => {
  const active = Boolean(fullscreenElement());
  if (active) {
    setPlayerMode(true);
    lockLandscape();
  } else if (!pseudoFullscreen) {
    leavePlayerMode();
  }
});
window.addEventListener('orientationchange', () => {
  if (pseudoFullscreen || fullscreenElement()) {
    setTimeout(() => setPlayerMode(true), 120);
  }
});
window.addEventListener('resize', () => {
  if (pseudoFullscreen || fullscreenElement()) setPlayerMode(true);
});
el.chatToggleBtn.addEventListener('click', () => setChatHidden(!chatHidden));
el.stage.addEventListener('pointermove', () => showCinemaUi());
el.stage.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('button,input,form')) showCinemaUi();
});
el.chatInput.addEventListener('focus', () => showCinemaUi(600000));
el.chatInput.addEventListener('blur', () => showCinemaUi());
el.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  el.chatInput.value = '';
  showCinemaUi(5200);
});

async function requestDisplayStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('이 브라우저는 화면 공유를 지원하지 않아');
  }

  const attempts = [
    {
      video: {
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: true,
    },
    { video: true, audio: true },
    { video: true, audio: false },
  ];

  let lastError;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (error) {
      lastError = error;
      console.warn('화면 공유 시도 실패:', error.name, error.message, constraints);
      if (error.name === 'NotAllowedError' || error.name === 'AbortError') throw error;
    }
  }
  throw lastError || new Error('화면 공유 요청 실패');
}

el.shareBtn.addEventListener('click', async () => {
  el.shareBtn.disabled = true;
  el.status.textContent = '화면 공유 권한 요청 중';

  try {
    localStream = await requestDisplayStream();

    const captureTrack = localStream.getVideoTracks()[0];
    if (!captureTrack) throw new Error('공유할 영상 트랙을 가져오지 못했어');

    try { captureTrack.contentHint = 'motion'; } catch (_) {}
    try {
      await captureTrack.applyConstraints({ frameRate: { ideal: 60, max: 60 } });
    } catch (constraintError) {
      console.warn('프레임 설정을 적용하지 못했지만 공유는 계속해:', constraintError);
    }

    setVideoStream(localStream, true);
    await el.video.play().catch((playError) => console.warn('로컬 미리보기 재생 실패:', playError));
    el.emptyState.classList.add('hidden');
    el.shareBtn.classList.add('hidden');
    el.stopBtn.classList.remove('hidden');
    el.status.textContent = '송출 중 · 친구 연결 대기';
    socket.emit('host-sharing', { sharing: true });

    captureTrack.addEventListener('ended', stopShare, { once: true });

    for (const viewerId of peers.keys()) await callViewer(viewerId);
    if (localStream.getAudioTracks().length === 0) {
      showToast('영상은 공유됐지만 소리는 없어. 크롬 탭 공유와 탭 오디오를 선택해줘');
    }
  } catch (error) {
    console.error('화면 공유 시작 오류:', error);
    el.status.textContent = '화면 공유 실패';

    const messages = {
      NotAllowedError: '화면 공유가 취소됐거나 권한이 거부됐어',
      AbortError: '화면 선택이 취소됐어',
      NotFoundError: '공유할 화면이나 창을 찾지 못했어',
      NotReadableError: 'macOS 화면 기록 권한을 확인해줘',
      InvalidStateError: '화면 공유 버튼을 다시 직접 눌러줘',
      OverconstrainedError: '요청한 화질 설정을 지원하지 않아',
      TypeError: '브라우저가 화면 공유 설정을 지원하지 않아',
    };
    showToast(`${messages[error.name] || error.message || '화면 공유를 시작하지 못했어'} (${error.name || 'Error'})`);
  } finally {
    el.shareBtn.disabled = false;
  }
});

el.stopBtn.addEventListener('click', stopShare);

function stopShare() {
  if (!localStream) return;
  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  closeAllPeers();
  clearVideoStream();
  el.video.muted = false;
  el.emptyState.classList.remove('hidden');
  el.stopBtn.classList.add('hidden');
  el.shareBtn.classList.remove('hidden');
  el.status.textContent = '송출 중지됨';
  socket.emit('host-sharing', { sharing: false });
}

function createPeer(target) {
  closePeer(target);
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(target, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) socket.emit('signal', { target, data: { candidate: event.candidate } });
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closePeer(target);
    if (role === 'host' && localStream) {
      const connected = [...peers.values()].filter((peer) => peer?.connectionState === 'connected').length;
      el.status.textContent = connected ? `송출 중 · ${connected}명 연결` : '송출 중 · 친구 연결 대기';
    } else if (role === 'viewer') {
      const labels = { connected: '시청 중', connecting: '연결 중', disconnected: '연결 끊김', failed: '연결 실패' };
      if (labels[pc.connectionState]) el.status.textContent = labels[pc.connectionState];
    }
  };
  return pc;
}

async function addQueuedCandidates(peerId, pc) {
  const queue = pendingCandidates.get(peerId) || [];
  for (const candidate of queue) await pc.addIceCandidate(candidate);
  pendingCandidates.delete(peerId);
}

async function callViewer(viewerId) {
  if (!localStream) return;
  const pc = createPeer(viewerId);
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  const videoSender = pc.getSenders().find((sender) => sender.track?.kind === 'video');
  if (videoSender) {
    const parameters = videoSender.getParameters();
    parameters.degradationPreference = 'maintain-framerate';
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = 8_000_000;
    parameters.encodings[0].maxFramerate = 60;
    await videoSender.setParameters(parameters).catch(() => {});
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { target: viewerId, data: { description: pc.localDescription } });
}

socket.on('viewer-ready', async ({ viewerId, nickname: viewerName }) => {
  if (!peers.has(viewerId)) peers.set(viewerId, null);
  showToast(`${viewerName || '친구'}님이 들어왔어`);
  if (localStream) await callViewer(viewerId);
});

socket.on('signal', async ({ from, data }) => {
  try {
    if (data.description?.type === 'offer') {
      const pc = createPeer(from);
      pc.ontrack = async (event) => {
        setVideoStream(event.streams[0], false);
        el.emptyState.classList.add('hidden');
        el.status.textContent = '시청 중';
        await el.video.play().catch(() => showToast('영상 화면을 한 번 눌러 재생해줘'));
      };
      await pc.setRemoteDescription(data.description);
      await addQueuedCandidates(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { target: from, data: { description: pc.localDescription } });
      return;
    }

    if (data.description?.type === 'answer') {
      const pc = peers.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(data.description);
      await addQueuedCandidates(from, pc);
      return;
    }

    if (data.candidate) {
      const pc = peers.get(from);
      if (pc?.remoteDescription) await pc.addIceCandidate(data.candidate);
      else {
        const queue = pendingCandidates.get(from) || [];
        queue.push(data.candidate);
        pendingCandidates.set(from, queue);
      }
    }
  } catch (error) {
    console.error(error);
    showToast('연결 처리 중 오류가 났어');
  }
});

socket.on('chat-message', ({ nickname: name, text }) => addMessage(name, text));
socket.on('system-message', ({ text }) => addMessage('', text, true));
socket.on('host-sharing', ({ sharing }) => {
  if (role !== 'viewer') return;
  if (sharing) {
    el.status.textContent = '송출 연결 중';
    updateViewerPlaceholder('영상 연결 중', '잠시 후 자동으로 영상이 나타나.');
    socket.emit('request-stream');
  } else {
    closeAllPeers();
    clearVideoStream();
    el.status.textContent = '방장 기다리는 중';
    updateViewerPlaceholder('송출이 잠시 멈췄어', '방장이 다시 화면 공유를 시작하면 자동으로 연결돼.');
  }
});

socket.on('presence', ({ count, max, members }) => {
  el.people.textContent = `👥 ${count}/${max}`;
  el.members.replaceChildren(...members.map((member) => {
    const chip = document.createElement('span');
    chip.className = `member ${member.role === 'host' ? 'host' : ''}`;
    chip.textContent = `${member.role === 'host' ? '★ ' : ''}${member.nickname}`;
    return chip;
  }));
});

socket.on('peer-left', ({ id, nickname: leftName }) => {
  closePeer(id);
  addMessage('', `${leftName}님이 방을 나갔어.`, true);
});

socket.on('host-left', () => {
  closeAllPeers();
  clearVideoStream();
  el.status.textContent = '방이 종료됐어';
  updateViewerPlaceholder('방장이 나갔어', '이 상영방은 종료됐어. 새로고침해서 새 방에 들어가줘.');
  el.chatInput.disabled = true;
  showToast('방장이 나가서 방이 종료됐어');
});

socket.on('disconnect', () => {
  if (!el.room.classList.contains('hidden')) el.status.textContent = '서버 재연결 중';
});
socket.on('connect', () => {
  if (!el.room.classList.contains('hidden') && roomId) location.reload();
});

const invitedRoom = roomFromUrl();
if (invitedRoom) el.roomCode.value = invitedRoom;
showCinemaUi();

updateInstallUi();
