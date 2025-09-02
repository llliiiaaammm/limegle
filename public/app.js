/* global supabase, ENV */
(() => {
  const els = {
    userId: document.getElementById("userId"),
    callBtn: document.getElementById("callBtn"),
    helpBtn: document.getElementById("helpBtn"),
    remoteVideo: document.getElementById("remoteVideo"),
    localVideo: document.getElementById("localVideo"),
    remoteMic: document.getElementById("remoteMic"),
    remoteCam: document.getElementById("remoteCam"),
    micEmoji: document.getElementById("micEmoji"),
    camEmoji: document.getElementById("camEmoji"),
    toggleMic: document.getElementById("toggleMic"),
    toggleCam: document.getElementById("toggleCam"),
    remoteRibbon: document.getElementById("remoteRibbon"),
    localRibbon: document.getElementById("localRibbon"),
    chatLog: document.getElementById("chatLog"),
    chatForm: document.getElementById("chatForm"),
    chatText: document.getElementById("chatText"),
  };

  // --- simple user id
  const uid = (() => {
    const k = "limegle_uid";
    let v = localStorage.getItem(k);
    if (!v) {
      // short, readable id
      v = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0).toString(36).slice(-6);
      localStorage.setItem(k, v);
    }
    return v;
  })();
  els.userId.textContent = uid;

  // --- supabase client
  const sb = supabase.createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY);
  // matchmaking channel (presence + broadcast)
  const mm = sb.channel("limegle-mm", {
    config: { presence: { key: uid }, broadcast: { self: true } },
  });

  let waiting = false;
  let roomId = null;
  let room = null;

  // --- WebRTC
  let pc = null;
  let dc = null;
  let localStream = null;
  let remoteMicOn = null;
  let remoteCamOn = null;

  const ICE_SERVERS = ENV.ICE_SERVERS && ENV.ICE_SERVERS.length ? ENV.ICE_SERVERS : [{ urls: "stun:stun.l.google.com:19302" }];

  function logSys(text) {
    pushMsg("system", "system", text);
  }
  function pushMsg(whoClass, whoLabel, text) {
    const row = document.createElement("div");
    row.className = `msg ${whoClass}`;
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = whoLabel;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    row.appendChild(who);
    row.appendChild(bubble);
    els.chatLog.appendChild(row);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  // UI state
  let micOn = true;
  let camOn = true;
  function updateLocalButtons() {
    els.micEmoji.textContent = micOn ? "🎙" : "🔇";
    els.camEmoji.textContent = camOn ? "📷" : "🚫";
    els.localRibbon.textContent = micOn && camOn ? "You" :
      (micOn && !camOn ? "You (camera off)" :
       (!micOn && camOn ? "You (mic off)" : "You (mic & camera off)"));
  }
  function updateRemoteIndicators() {
    const micOk = remoteMicOn !== false;
    const camOk = remoteCamOn !== false;
    els.remoteMic.innerHTML = `<span>${micOk ? "🎙" : "🔇"}</span>`;
    els.remoteCam.innerHTML = `<span>${camOk ? "📷" : "🚫"}</span>`;
    const flags = [];
    if (remoteMicOn === false) flags.push("mic off");
    if (remoteCamOn === false) flags.push("camera off");
    els.remoteRibbon.textContent = flags.length ? `Partner (${flags.join(" / ")})` : "Partner";
  }

  function createPC(isCaller) {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        room?.send({ type: "broadcast", event: "signal", payload: { t: "candidate", c: e.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        cleanupRoom("Connection ended");
      }
    };

    pc.ontrack = (e) => {
      els.remoteVideo.srcObject = e.streams[0];
      els.remoteRibbon.textContent = "Partner";
    };

    // Data channel
    if (isCaller) {
      dc = pc.createDataChannel("chat");
      attachDC();
    } else {
      pc.ondatachannel = (e) => {
        dc = e.channel;
        attachDC();
      };
    }
  }

  function attachDC() {
    dc.onopen = () => {
      // send our current state so the partner sees indicators immediately
      sendState();
      logSys("Connected.");
    };
    dc.onclose = () => logSys("Data channel closed.");
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.kind === "chat") {
          pushMsg("peer", "Stranger", msg.text);
        } else if (msg.kind === "state") {
          remoteMicOn = msg.mic;
          remoteCamOn = msg.cam;
          updateRemoteIndicators();
        }
      } catch {
        // plaintext fallback
        pushMsg("peer", "Stranger", String(e.data));
      }
    };
  }

  async function getMedia() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    els.localVideo.srcObject = localStream;
    return localStream;
  }

  function applyLocalTrackState() {
    if (!localStream) return;
    const a = localStream.getAudioTracks()[0];
    const v = localStream.getVideoTracks()[0];
    if (a) a.enabled = !!micOn;
    if (v) v.enabled = !!camOn;
  }

  function sendState() {
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify({ kind: "state", mic: !!micOn, cam: !!camOn }));
    }
  }

  async function startCallFlow(asCaller) {
    await getMedia();
    createPC(asCaller);

    // add tracks
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    applyLocalTrackState();

    if (asCaller) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await room.send({ type: "broadcast", event: "signal", payload: { t: "offer", sdp: offer } });
    }
  }

  async function joinRoom(id, asCaller) {
    if (room) return;
    roomId = id;
    room = sb.channel(`limegle-room-${id}`, { config: { broadcast: { self: false } } });

    room.on("broadcast", { event: "signal" }, async ({ payload }) => {
      if (!pc) return;
      if (payload.t === "offer") {
        await pc.setRemoteDescription(payload.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await room.send({ type: "broadcast", event: "signal", payload: { t: "answer", sdp: answer } });
      } else if (payload.t === "answer") {
        await pc.setRemoteDescription(payload.sdp);
      } else if (payload.t === "candidate" && payload.c) {
        try { await pc.addIceCandidate(payload.c); } catch {}
      }
    });

    await room.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await startCallFlow(asCaller);
      }
    });
  }

  async function cleanupRoom(reason = "Left") {
    if (dc) { try { dc.close(); } catch {} dc = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (room) { try { await room.unsubscribe(); } catch {} room = null; }
    roomId = null;
    remoteMicOn = null; remoteCamOn = null; updateRemoteIndicators();
    els.remoteVideo.srcObject = null;
    els.remoteRibbon.textContent = "Waiting for a partner…";
    if (waiting) {
      // stay waiting
    } else {
      logSys(reason);
    }
    els.callBtn.disabled = false;
    els.callBtn.textContent = "Call";
  }

  // --- Matchmaking via Supabase Presence
  async function pickPartnerFromPresence() {
    const state = await mm.presenceState();
    // state = { uid: [{metas:{waiting:true, ts}}], ... }
    const others = Object.entries(state).filter(([k]) => k !== uid);
    // prefer oldest waiting user
    const waitingPeers = others
      .map(([k, v]) => ({ id: k, metas: v }))
      .filter(row => row.metas.some(m => m.metas?.waiting))
      .sort((a,b) => {
        const ta = a.metas[0].metas.ts || 0;
        const tb = b.metas[0].metas.ts || 0;
        return ta - tb;
      });
    return waitingPeers.length ? waitingPeers[0].id : null;
  }

  mm.on("broadcast", { event: "invite" }, async ({ payload }) => {
    if (payload.to !== uid || room) return;
    waiting = false;
    await mm.track({ waiting: false, ts: Date.now() });
    els.callBtn.textContent = "Connecting…";
    await joinRoom(payload.roomId, /* caller? */ false);
  });

  async function goCall() {
    if (room) { await cleanupRoom("Restarting…"); }
    els.callBtn.disabled = true;
    els.callBtn.textContent = "Matching…";

    // Find someone already waiting
    const partner = await pickPartnerFromPresence();
    if (partner) {
      const id = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
      await mm.send({ type: "broadcast", event: "invite", payload: { to: partner, from: uid, roomId: id } });
      await joinRoom(id, /* caller */ true);
      return;
    }

    // Otherwise, mark self waiting and hope someone invites us
    waiting = true;
    await mm.track({ waiting: true, ts: Date.now() });
    logSys("Waiting for a partner…");
    els.callBtn.disabled = false;
    els.callBtn.textContent = "Cancel";
  }

  // --- Wire UI
  els.callBtn.addEventListener("click", async () => {
    if (!waiting && !room) {
      await goCall();
    } else if (waiting && !room) {
      waiting = false;
      els.callBtn.disabled = true;
      els.callBtn.textContent = "Canceling…";
      await mm.track({ waiting: false, ts: Date.now() });
      els.callBtn.disabled = false;
      els.callBtn.textContent = "Call";
      logSys("Canceled.");
    } else if (room) {
      await cleanupRoom("Left");
    }
  });

  els.toggleMic.addEventListener("click", () => {
    micOn = !micOn;
    applyLocalTrackState();
    updateLocalButtons();
    sendState();
  });
  els.toggleCam.addEventListener("click", () => {
    camOn = !camOn;
    applyLocalTrackState();
    updateLocalButtons();
    sendState();
  });

  els.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.chatText.value.trim();
    if (!text) return;
    els.chatText.value = "";
    pushMsg("you", "You", text);
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify({ kind: "chat", text }));
    } else {
      logSys("Not connected.");
    }
  });

  // subscribe to matchmaking channel
  mm.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      await mm.track({ waiting: false, ts: Date.now() });
    }
  });

  // bootstrap: get camera so user sees themself immediately (optional)
  (async () => {
    try {
      await getMedia();
    } catch (err) {
      logSys("Camera/mic permission denied. You can still connect with audio/video off.");
      micOn = false; camOn = false; updateLocalButtons();
    }
    updateLocalButtons();
    updateRemoteIndicators();
  })();

  // help button (placeholder)
  document.getElementById("helpBtn").addEventListener("click", () => {
    alert("Help placeholder. Tips:\n• Click Call to match.\n• Use the mic/camera buttons on your tile.\n• Add a TURN server in env.js for reliability.");
  });
})();
