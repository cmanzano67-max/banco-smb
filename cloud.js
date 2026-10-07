/* Banco de situaciones SMB · versión web
   Capa de nube: cuentas (Firebase Authentication) y datos (Cloud Firestore).
   La app es la misma que la del artifact; esta capa le da por debajo lo que allí daba claude.ai:
   - window.claude.use('artifact' | 'user' | 'db' | 'downloads') con la misma forma,
   - window.SMB_CLOUD: sincroniza lo de cada entrenador, la bandeja de la DT y el acceso.
   Todo se guarda como texto JSON en el campo «j» porque Firestore no admite listas dentro de listas
   (los trazos de los gráficos lo son). */
(function () {
  'use strict';
  const enc = o => ({ j: JSON.stringify(o) });
  const dec = d => { try { return d && typeof d.j === 'string' ? JSON.parse(d.j) : null; } catch (e) { return null; } };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').trim().toLowerCase();
  const LS = { mine: 'smb-banco-mis-versiones', sessions: 'smb-banco-sesiones', autor: 'smb-banco-autor', game: 'smb-banco-personaje', envios: 'smb-banco-envios' };
  const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const DT_UIDS = window.SMB_DT_UIDS || [];

  // ---------- backend: Firebase (o uno simulado en las pruebas) ----------
  function firebaseBackend() {
    firebase.initializeApp(window.SMB_FIREBASE);
    const auth = firebase.auth(), db = firebase.firestore();
    try { db.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}
    const user = u => u ? { uid: u.uid, email: u.email || '', name: u.displayName || '', verified: !!u.emailVerified, password: (u.providerData || []).some(p => p && p.providerId === 'password') && !(u.providerData || []).some(p => p && p.providerId === 'google.com') } : null;
    return {
      onAuth: cb => auth.onAuthStateChanged(u => cb(user(u))),
      google: () => {
        const p = new firebase.auth.GoogleAuthProvider();
        return auth.signInWithPopup(p).catch(e => { if (e && /popup|operation-not-supported/.test(e.code || '')) return auth.signInWithRedirect(p); throw e; });
      },
      emailIn: (email, pass) => auth.signInWithEmailAndPassword(email, pass),
      emailUp: (email, pass) => auth.createUserWithEmailAndPassword(email, pass).then(c => c.user.sendEmailVerification().catch(() => {})),
      verify: () => auth.currentUser ? auth.currentUser.sendEmailVerification() : Promise.resolve(),
      refresh: async () => { if (!auth.currentUser) return null; await auth.currentUser.reload(); await auth.currentUser.getIdToken(true); return user(auth.currentUser); },
      reset: email => auth.sendPasswordResetEmail(email),
      signOut: () => auth.signOut(),
      listenDoc: (p, cb, er) => db.doc(p).onSnapshot(s => cb(s.exists ? s.data() : null), er),
      listenCol: (p, cb, er) => db.collection(p).onSnapshot(s => cb(s.docs.map(d => ({ id: d.id, data: d.data() }))), er),
      getCol: p => db.collection(p).get().then(s => s.docs.map(d => ({ id: d.id, data: d.data() }))),
      getDoc: p => db.doc(p).get().then(s => s.exists ? s.data() : null),
      set: (p, d) => db.doc(p).set(d),
      merge: (p, d) => db.doc(p).set(d, { merge: true }),
      del: p => db.doc(p).delete(),
      batch: async ops => {
        for (let i = 0; i < ops.length; i += 400) {
          const b = db.batch();
          ops.slice(i, i + 400).forEach(o => o.op === 'del' ? b.delete(db.doc(o.path)) : b.set(db.doc(o.path), o.data));
          await b.commit();
        }
      },
    };
  }
  const B = window.SMB_BACKEND || firebaseBackend();

  // ---------- estado ----------
  let me = null, isDT = false, member = false, readyResolve, unsub = [];
  const ready = new Promise(r => { readyResolve = r; });
  const C = { state: undefined, tasks: null, hist: null, liga: null, profiles: {}, inbox: [], votes: [] };
  const voteSubs = [];
  let lastBank = null, assembleT = null, pulled = false, memberStarted = false;

  // ---------- pantalla de acceso ----------
  function gate(html) {
    let g = document.getElementById('cl-gate');
    if (!g) { g = document.createElement('div'); g.id = 'cl-gate'; g.className = 'cl-gate'; document.body.appendChild(g); }
    g.hidden = !html; if (html) g.innerHTML = `<div class="cl-card"><img src="${esc(window.SMB_LOGO || '')}" alt="" width="64" height="64"><div class="cl-eyebrow">CHP Santa María la Blanca</div>${html}</div>`;
    document.documentElement.classList.toggle('cl-locked', !!html);
  }
  const loginHTML = (msg) => `<h1>Banco de situaciones</h1><p>Entra con Google o con tu email: usa el mismo email que le diste a la Dirección Técnica y tendrás acceso directo.</p>
    <button class="btn primary cl-wide" type="button" data-cl="google">Entrar con Google</button>
    <div class="cl-or"><span>o con tu email</span></div>
    <label class="ses-f">Email<input type="email" id="cl-email" autocomplete="email"></label>
    <label class="ses-f">Contraseña<input type="password" id="cl-pass" autocomplete="current-password"></label>
    <div class="cl-row"><button class="btn primary" type="button" data-cl="in">Entrar</button><button class="btn" type="button" data-cl="up">Crear cuenta</button></div>
    <button class="linkb" type="button" data-cl="reset">He olvidado mi contraseña</button>
    <p class="msg${msg ? ' err' : ''}" id="cl-msg" aria-live="polite">${esc(msg || '')}</p>`;
  const pendingHTML = () => me.password && !me.verified ? `<h1>Confirma tu email</h1><p>Te hemos mandado un correo a <b>${esc(me.email)}</b> con un enlace. Púlsalo (mira también en «Spam») y vuelve aquí.</p>
    <div class="cl-row"><button class="btn primary" type="button" data-cl="verified">Ya lo he confirmado</button><button class="btn" type="button" data-cl="resend">Reenviar el correo</button></div>
    <button class="linkb" type="button" data-cl="out">Salir</button>
    <p class="msg" id="cl-msg" aria-live="polite"></p>` : `<h1>Casi está</h1><p>Tu cuenta (${esc(me.email || me.name)}) está creada. Falta que la Dirección Técnica te dé acceso. En cuanto lo haga, esta pantalla se abre sola.</p>
    <label class="ses-f">Tu nombre, como firmas tus ejercicios<input type="text" id="cl-name" value="${esc(readLS(LS.autor, null) || localStorage.getItem(LS.autor) || me.name || '')}"></label>
    <div class="cl-row"><button class="btn primary" type="button" data-cl="name">Guardar nombre</button><button class="btn ghost" type="button" data-cl="out">Salir</button></div>
    <p class="msg" id="cl-msg" aria-live="polite"></p>
    <p class="cl-uid">Código de usuario: <code>${esc(me.uid)}</code></p>`;
  const bootHTML = () => `<h1>Primera vez</h1><p>Eres la Dirección Técnica y el banco está vacío. Sube la copia del banco que descargaste de la versión anterior (Dirección Técnica → Banco → «Descargar copia del banco»).</p>
    <label class="ses-f">Copia del banco (.json)<input type="file" id="cl-bankfile" accept=".json,application/json"></label>
    <div class="cl-row"><button class="btn primary" type="button" data-cl="import">Importar</button><button class="btn" type="button" data-cl="empty">Empezar vacío</button></div>
    <p class="msg" id="cl-msg" aria-live="polite"></p>`;
  const msgEl = () => document.getElementById('cl-msg');
  const say = (t, err) => { const m = msgEl(); if (m) { m.className = 'msg ' + (err ? 'err' : 'ok'); m.textContent = t; } };
  const AUTH_ERR = { 'auth/invalid-credential': 'Email o contraseña incorrectos.', 'auth/wrong-password': 'Contraseña incorrecta.', 'auth/user-not-found': 'No hay ninguna cuenta con ese email. Pulsa «Crear cuenta».', 'auth/email-already-in-use': 'Ese email ya tiene cuenta. Pulsa «Entrar».', 'auth/weak-password': 'La contraseña tiene que tener al menos 6 caracteres.', 'auth/invalid-email': 'Ese email no es válido.', 'auth/popup-closed-by-user': 'Has cerrado la ventana de Google.', 'auth/network-request-failed': 'Sin conexión. Inténtalo de nuevo.' };
  const authErr = e => AUTH_ERR[e && e.code] || 'No se ha podido entrar. Inténtalo de nuevo.';

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-cl]'); if (!b) return;
    const a = b.dataset.cl, v = id => (document.getElementById(id) || {}).value || '';
    try {
      if (a === 'google') await B.google();
      else if (a === 'in') await B.emailIn(v('cl-email').trim(), v('cl-pass'));
      else if (a === 'up') await B.emailUp(v('cl-email').trim(), v('cl-pass'));
      else if (a === 'reset') { if (!v('cl-email').trim()) return say('Escribe tu email arriba y vuelve a pulsar.', true); await B.reset(v('cl-email').trim()); say('Te hemos mandado un correo para cambiar la contraseña.'); }
      else if (a === 'resend') { await B.verify(); say('Correo reenviado.'); }
      else if (a === 'verified') { const u = await B.refresh(); if (u) me = u; if (!me.verified) { say('Todavía no consta confirmado. Pulsa el enlace del correo y vuelve a probar.', true); return; } unsub.forEach(f => { try { f(); } catch (er) {} }); unsub = []; gate('<h1>Entrando…</h1>'); listenState(); }
      else if (a === 'prereg') { const n = v('cl-pre-name').trim(), em = norm(v('cl-pre-email')); if (!n || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { window.SMB.toast('Pon el nombre y un email válido.'); return; } await prereg(n, em); }
      else if (a === 'unprereg') await unprereg(b.dataset.email);
      else if (a === 'out') { await B.signOut(); clearPersonal(); setTimeout(() => location.reload(), 60); }
      else if (a === 'name') { const n = v('cl-name').trim(); if (!n) return; try { localStorage.setItem(LS.autor, n); } catch (er) {} await pushProfile(); say('Nombre guardado.'); }
      else if (a === 'import') { const f = document.getElementById('cl-bankfile').files[0]; if (!f) return say('Elige el archivo.', true); const j = JSON.parse(await f.text()); await importBank(j); say('Banco importado.'); }
      else if (a === 'empty') await importBank({ updated: '', tasks: [] });
      else if (a === 'grant') await grant(b.dataset.uid);
      else if (a === 'revoke') await revoke(b.dataset.uid);
      else if (a === 'rv') window.SMB.review(C.inbox.find(x => x.id === b.dataset.id).code);
      else if (a === 'done') await B.merge('inbox/' + b.dataset.id, { estado: 'hecho' });
      else if (a === 'restore') { const f = document.getElementById('cl-restorefile').files[0]; if (!f) return; const j = JSON.parse(await f.text()); if (!Array.isArray(j.tasks)) throw new Error('bad'); await importBank(Object.assign({}, j, { memberUids: (lastBank || {}).memberUids || [], dtUids: (lastBank || {}).dtUids || [] })); window.SMB.toast('Banco restaurado.'); }
    } catch (er) {
      if (['google', 'in', 'up', 'reset'].includes(a)) say(authErr(er), true);
      else { say('No se ha podido hacer. ' + (er && er.message ? '(' + er.message + ')' : ''), true); if (window.SMB) window.SMB.toast('No se ha podido hacer. Inténtalo de nuevo.'); }
    }
  });

  // ---------- sesión ----------
  const clearPersonal = () => { Object.values(LS).forEach(k => { try { localStorage.removeItem(k); } catch (e) {} }); lastPushed.mine = new Map(); lastPushed.sessions = new Map(); if (window.SMB) window.SMB.reloadLocal(); };
  B.onAuth(u => {
    unsub.forEach(f => { try { f(); } catch (e) {} }); unsub = [];
    const was = me; me = u; member = false; pulled = false; memberStarted = false; C.state = undefined;
    if (!u) { if (was) clearPersonal(); try { localStorage.removeItem('smb-cloud-uid'); } catch (e) {} gate(loginHTML()); return; }
    let prevUid = null; try { prevUid = localStorage.getItem('smb-cloud-uid'); localStorage.setItem('smb-cloud-uid', u.uid); } catch (e) {}
    if (prevUid && prevUid !== u.uid) clearPersonal();
    isDT = DT_UIDS.includes(u.uid);
    gate('<h1>Entrando…</h1>');
    pushProfile().catch(() => {});
    listenState();
  });
  function listenState() {
    unsub.push(B.listenDoc('club/state', d => {
      C.state = d;
      if (d && Array.isArray(d.dtUids) && d.dtUids.includes(me.uid)) isDT = true;
      member = isDT || !!(d && ((d.memberUids || []).includes(me.uid) || (me.verified && (d.memberEmails || []).includes(norm(me.email)))));
      if (!d && isDT) { gate(bootHTML()); return; }
      if (!member) { gate(pendingHTML()); return; }
      onMember();
    }, () => { gate(pendingHTML()); setTimeout(() => { if (me && !member) { unsub.forEach(f => { try { f(); } catch (e) {} }); unsub = []; listenState(); } }, 20000); }));
  }
  async function onMember() {
    if (memberStarted) { assemble(); return; }
    memberStarted = true;
    unsub.push(B.listenCol('tasks', d => { C.tasks = d; assemble(); }));
    unsub.push(B.listenCol('historial', d => { C.hist = d; assemble(); }));
    unsub.push(B.listenCol('liga', d => { C.liga = d; assemble(); }));
    unsub.push(B.listenCol('profiles', d => { C.profiles = Object.fromEntries(d.map(x => [x.id, x.data])); assemble(); }));
    unsub.push(B.listenCol('votes', d => { C.votes = d; voteSubs.forEach(f => f()); }));
    if (isDT) unsub.push(B.listenCol('inbox', d => { C.inbox = d.map(x => Object.assign({ id: x.id }, x.data)).filter(x => x.estado !== 'hecho').sort((a, b) => b.ts - a.ts); if (window.SMB) window.SMB.render(); }));
    await pullPersonal();
    gate('');
    readyResolve();
  }

  // ---------- banco: leer ----------
  function assemble() {
    clearTimeout(assembleT);
    assembleT = setTimeout(() => {
      if (!C.state || !C.tasks || !C.hist || !C.liga) return;
      const st = dec(C.state) || {};
      const bank = Object.assign({}, st, {
        tasks: C.tasks.map(x => ({ o: x.data.o || 0, t: dec(x.data) })).filter(x => x.t).sort((a, b) => a.o - b.o).map(x => x.t),
        historial: C.hist.map(x => ({ o: x.data.o || 0, t: dec(x.data) })).filter(x => x.t).sort((a, b) => a.o - b.o).map(x => x.t),
        liga: C.liga.map(x => dec(x.data)).filter(Boolean).sort((a, b) => a.n - b.n),
        memberUids: C.state.memberUids || [], dtUids: C.state.dtUids || [], memberEmails: C.state.memberEmails || [],
      });
      const byEmail = em => { const e = Object.entries(C.profiles).find(([, p]) => norm(p.email) === norm(em)); return e ? e[1] : null; };
      bank.coaches = (st.coaches || []).map(c => { const p = (c.uid && C.profiles[c.uid]) || (c.email && byEmail(c.email)); const pj = p ? dec(p) || {} : {}; return p ? Object.assign({}, c, { name: p.name || c.name, avatar: pj.avatar || c.avatar, poder: pj.poder || c.poder }) : c; });
      lastBank = bank;
      if (window.SMB) window.SMB.setBank(bank);
    }, 60);
  }

  // ---------- banco: escribir (lo llama la app a través de artifact.publish) ----------
  async function saveBank(next) {
    if (!isDT) { const e = new Error('not_writer'); e.code = 'not_writer'; throw e; }
    const prev = lastBank || { tasks: [], historial: [], liga: [] }, ops = [];
    const diff = (col, list, idOf, prevList) => {
      const old = new Map((prevList || []).map((t, i) => [idOf(t), JSON.stringify(t) + '#' + i]));
      const ids = new Set();
      list.forEach((t, i) => { const id = idOf(t); ids.add(id); if (old.get(id) !== JSON.stringify(t) + '#' + i) ops.push({ op: 'set', path: `${col}/${id}`, data: Object.assign(enc(t), { o: i }) }); });
      old.forEach((v, id) => { if (!ids.has(id)) ops.push({ op: 'del', path: `${col}/${id}` }); });
    };
    diff('tasks', next.tasks || [], t => t.id, prev.tasks);
    diff('historial', next.historial || [], h => String(h.id).replace(/[^\w.-]/g, '_'), prev.historial);
    diff('liga', next.liga || [], j => 'j' + j.n, prev.liga);
    const rest = Object.assign({}, next); ['tasks', 'historial', 'liga', 'memberUids', 'dtUids', 'memberEmails'].forEach(k => delete rest[k]);
    rest.coaches = (rest.coaches || []).map(c => (c.uid || c.email) ? Object.assign({ name: c.name, bonus: c.bonus || [] }, c.uid ? { uid: c.uid } : {}, c.email ? { email: c.email } : {}) : c);
    delete rest.memberEmails;
    ops.push({ op: 'set', path: 'club/state', data: Object.assign(enc(rest), { memberUids: next.memberUids || prev.memberUids || [], memberEmails: next.memberEmails || prev.memberEmails || [], dtUids: next.dtUids || prev.dtUids || [me.uid] }) });
    await B.batch(ops);
  }
  async function importBank(j) {
    if (!isDT) throw new Error('Solo la Dirección Técnica');
    const next = Object.assign({ tasks: [], historial: [], liga: [] }, j);
    next.dtUids = [...new Set([...(next.dtUids || []), me.uid])];
    next.memberUids = next.memberUids || [];
    const keep = lastBank; lastBank = { tasks: [], historial: [], liga: [] };
    try { await saveBank(next); } catch (e) { lastBank = keep; throw e; }
    if (keep) { // borra lo que ya no está
      const ops = [];
      keep.tasks.forEach(t => { if (!next.tasks.some(x => x.id === t.id)) ops.push({ op: 'del', path: 'tasks/' + t.id }); });
      if (ops.length) await B.batch(ops);
    }
  }

  // ---------- acceso ----------
  async function grant(uid) {
    const b = lastBank, p = C.profiles[uid] || {}, name = (p.name || p.nameHint || p.email || 'Entrenador').trim();
    const coaches = (b.coaches || []).map(c => Object.assign({}, c));
    const c = coaches.find(x => !x.uid && norm(x.name) === norm(name));
    if (c) c.uid = uid; else if (!coaches.some(x => x.uid === uid)) coaches.push({ name, uid, bonus: [] });
    await window.SMB.saveBankExtra({ coaches, memberUids: [...new Set([...(b.memberUids || []), uid])] }, `${name} ya tiene acceso.`);
  }
  async function revoke(uid) {
    const b = lastBank, p = C.profiles[uid] || {};
    await window.SMB.saveBankExtra({ memberUids: (b.memberUids || []).filter(x => x !== uid), memberEmails: (b.memberEmails || []).filter(x => x !== norm(p.email)) }, 'Acceso quitado. Su personaje y sus ejercicios siguen.');
  }
  async function prereg(name, email) {
    const b = lastBank, coaches = (b.coaches || []).map(c => Object.assign({}, c));
    const c = coaches.find(x => norm(x.email) === email) || coaches.find(x => !x.email && norm(x.name) === norm(name));
    if (c) { c.email = email; c.name = c.name || name; } else coaches.push({ name, email, bonus: [] });
    await window.SMB.saveBankExtra({ coaches, memberEmails: [...new Set([...(b.memberEmails || []), email])] }, `${name} dado de alta. Cuando entre con ${email}, tendrá acceso directo.`);
  }
  async function unprereg(email) {
    const b = lastBank;
    await window.SMB.saveBankExtra({ coaches: (b.coaches || []).filter(x => !(norm(x.email) === email && !x.uid && !Object.values(C.profiles).some(p => norm(p.email) === email))), memberEmails: (b.memberEmails || []).filter(x => x !== email) }, 'Alta quitada.');
  }

  // ---------- lo de cada entrenador ----------
  const lastPushed = { mine: new Map(), sessions: new Map() };
  async function pullPersonal() {
    const base = 'users/' + me.uid;
    const [meta, cm, cs] = await Promise.all([B.getDoc(base + '/meta/state'), B.getCol(base + '/mine'), B.getCol(base + '/sessions')]);
    const merge = (key, cloud) => {
      const local = readLS(LS[key], []), map = new Map(local.map(x => [x.id, x]));
      cloud.forEach(x => { const t = dec(x.data); if (t) { map.set(t.id, t); lastPushed[key].set(t.id, JSON.stringify(t)); } });
      try { localStorage.setItem(LS[key], JSON.stringify([...map.values()])); } catch (e) {}
    };
    merge('mine', cm); merge('sessions', cs);
    const m = dec(meta);
    if (!(m && m.autor) && !localStorage.getItem(LS.autor)) {
      const pr = await B.getDoc('profiles/' + me.uid).catch(() => null);
      const st = C.state ? dec(C.state) || {} : {}, pc = (st.coaches || []).find(c => norm(c.email) === norm(me.email) || c.uid === me.uid);
      const n = (pc && pc.name) || (pr && (pr.name || pr.nameHint)) || me.name; if (n) try { localStorage.setItem(LS.autor, n); } catch (e) {}
    }
    if (m) {
      try {
        if (m.autor) localStorage.setItem(LS.autor, m.autor);
        if (m.game) localStorage.setItem(LS.game, JSON.stringify(m.game));
        if (m.envios) localStorage.setItem(LS.envios, JSON.stringify(m.envios));
      } catch (e) {}
    }
    pulled = true;
    if (window.SMB) window.SMB.reloadLocal();
    // lo local que no estaba en la nube se sube
    push('mine'); push('sessions'); if (!m) push('meta');
  }
  const timers = {};
  function push(k) {
    if (!me || !pulled) return;
    clearTimeout(timers[k]); timers[k] = setTimeout(() => doPush(k).catch(() => {}), 700);
  }
  async function doPush(k) {
    const base = 'users/' + me.uid;
    if (k === 'mine' || k === 'sessions') {
      const list = readLS(LS[k], []), ops = [], ids = new Set();
      list.forEach(t => { if (!t || !t.id) return; ids.add(t.id); const s = JSON.stringify(t); if (lastPushed[k].get(t.id) !== s) ops.push({ op: 'set', path: `${base}/${k}/${t.id}`, data: enc(t) }); });
      lastPushed[k].forEach((v, id) => { if (!ids.has(id)) ops.push({ op: 'del', path: `${base}/${k}/${id}` }); });
      if (!ops.length) return;
      await B.batch(ops);
      lastPushed[k] = new Map(list.filter(t => t && t.id).map(t => [t.id, JSON.stringify(t)]));
    } else {
      await B.set(base + '/meta/state', enc({ autor: localStorage.getItem(LS.autor) || '', game: readLS(LS.game, null), envios: readLS(LS.envios, []) }));
      await pushProfile();
    }
  }
  async function pushProfile() {
    if (!me) return;
    const g = readLS(LS.game, null), name = localStorage.getItem(LS.autor) || '';
    const d = { email: me.email || '', ts: Date.now() };
    if (name) d.name = name; else if (me.name && !pulled) d.nameHint = me.name;
    if (g && g.av) Object.assign(d, enc({ avatar: g.av, poder: g.poder || '' }));
    await B.merge('profiles/' + me.uid, d);
  }

  // ---------- lo que la app pide a window.claude ----------
  const shims = {
    artifact: { publish: async files => { const raw = files && files['data/banco.json']; if (!raw) throw Object.assign(new Error('bad'), { code: 'invalid_argument' }); await saveBank(JSON.parse(raw)); } },
    user: { isOwner: async () => isDT, canEdit: async () => isDT, id: async () => me && me.uid, can: async () => member, me: async () => ({ id: me && me.uid, name: '', email: null }) },
    downloads: {
      save: async ({ filename, data }) => {
        const blob = data instanceof Blob ? data : new Blob([data], { type: /\.json$/.test(filename) ? 'application/json' : 'text/plain' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      },
    },
    db: {
      collection: path => ({
        onSnapshot: (next) => {
          const f = () => next({ docs: C.votes.map(d => ({ id: d.id, exists: true, data: () => d.data })), size: C.votes.length, empty: !C.votes.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } });
          voteSubs.push(f); f(); return () => {};
        },
      }),
      doc: path => ({ set: data => B.set(path, data) }),
    },
  };
  window.claude = { use: name => ready.then(() => shims[name] || null) };

  // ---------- piezas de pantalla para la app ----------
  window.SMB_CLOUD = {
    push,
    send: async o => {
      if (o.kind === 'pj') { await pushProfile(); return; }
      await B.set('inbox/' + (o.kind + '-' + me.uid.slice(0, 8) + '-' + Date.now().toString(36)), { kind: o.kind, code: o.code, title: o.title || '', autor: localStorage.getItem(LS.autor) || '', uid: me.uid, ts: Date.now(), estado: 'nuevo' });
    },
    inboxHTML: () => {
      if (!C.inbox.length) return '<section class="ses-sec"><h2 class="h-sec">Recibido</h2><p class="sub">No hay nada nuevo de los entrenadores.</p></section>';
      const K = { ej: 'Ejercicio', ses: 'Sesión' };
      return `<section class="ses-sec"><h2 class="h-sec">Recibido · ${C.inbox.length}</h2><ul class="env-list">${C.inbox.map(x => `<li><span class="env-k">${K[x.kind] || x.kind}</span><span class="env-t"><b>${esc(x.title)}</b><small>De ${esc(x.autor || 'un entrenador')} · ${new Date(x.ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</small></span><span class="actions"><button class="btn small primary" type="button" data-cl="rv" data-id="${esc(x.id)}">Revisar</button><button class="btn small ghost" type="button" data-cl="done" data-id="${esc(x.id)}">Hecho</button></span></li>`).join('')}</ul></section>`;
    },
    accessHTML: () => {
      const b = lastBank || {}, mem = new Set(b.memberUids || []);
      const all = Object.entries(C.profiles);
      const memE = new Set(b.memberEmails || []), has = ([uid, p]) => mem.has(uid) || memE.has(norm(p.email));
      const pend = all.filter(x => !has(x)), ok = all.filter(x => has(x));
      const row = ([uid, p], btn) => `<li class="dt-row"><span class="dt-thumb cl-ini">${esc((p.name || p.nameHint || p.email || '?').slice(0, 1).toUpperCase())}</span><span class="dt-txt"><b>${esc(p.name || p.nameHint || 'Sin nombre')}${me && uid === me.uid ? ' (tú)' : ''}</b><small>${esc(p.email || '')}</small></span>${btn}</li>`;
      const emailsIn = new Set(Object.values(C.profiles).map(p => norm(p.email)));
      const pre = (b.memberEmails || []).filter(e => !emailsIn.has(e)).map(e => ({ e, c: (b.coaches || []).find(x => norm(x.email) === e) }));
      return `<section class="ses-sec"><h2 class="h-sec">Acceso</h2>
        <h3 class="h-sub">Dar de alta a un entrenador</h3>
        <p class="sub">Con el email con el que va a entrar (su Gmail, si entra con Google). Al entrar tendrá acceso directo y aparecerá en el cuerpo técnico con este nombre.</p>
        <div class="cl-pre"><input type="text" id="cl-pre-name" placeholder="Nombre, como firma sus ejercicios" aria-label="Nombre"><input type="email" id="cl-pre-email" placeholder="email@ejemplo.com" aria-label="Email"><button class="btn primary" type="button" data-cl="prereg">Dar de alta</button></div>
        ${pre.length ? `<h3 class="h-sub">Dados de alta, todavía sin entrar (${pre.length})</h3><ul class="dt-list">${pre.map(({ e, c }) => `<li class="dt-row"><span class="dt-thumb cl-ini">${esc(((c && c.name) || e).slice(0, 1).toUpperCase())}</span><span class="dt-txt"><b>${esc((c && c.name) || 'Sin nombre')}</b><small>${esc(e)}</small></span><button class="btn small ghost" type="button" data-cl="unprereg" data-email="${esc(e)}">Quitar</button></li>`).join('')}</ul>` : ''}
        ${pend.length ? `<h3 class="h-sub">Esperando acceso (${pend.length})</h3><ul class="dt-list">${pend.map(x => row(x, `<button class="btn small primary" type="button" data-cl="grant" data-uid="${esc(x[0])}">Dar acceso</button>`)).join('')}</ul>` : '<p class="sub">Nadie esperando. Cuando un entrenador crea su cuenta, aparece aquí.</p>'}
        ${ok.length ? `<details><summary>Con acceso (${ok.length})</summary><ul class="dt-list">${ok.map(x => row(x, `<button class="btn small ghost" type="button" data-cl="revoke" data-uid="${esc(x[0])}">Quitar acceso</button>`)).join('')}</ul></details>` : ''}
      </section>`;
    },
    restoreHTML: () => `<section class="ses-sec"><h2 class="h-sec">Restaurar el banco</h2><p class="sub">Sustituye el banco por una copia descargada antes. Los accesos se mantienen.</p>
      <label class="ses-f">Copia (.json)<input type="file" id="cl-restorefile" accept=".json,application/json"></label><div class="actions"><button class="btn" type="button" data-cl="restore">Restaurar</button></div></section>`,
    accountHTML: () => `<h3 class="h-sub">Tu cuenta</h3><p class="sub">${esc(me ? me.email || me.name : '')}. Lo tuyo se guarda en tu cuenta: entra con ella en cualquier móvil u ordenador.</p><div class="actions"><button class="btn ghost" type="button" data-cl="out">Cerrar sesión</button></div>`,
  };
})();
