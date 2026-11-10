// The start screen's own script (no framework, no remote content): my office, or someone else's.
const form = document.getElementById('form');
const error = document.getElementById('error');
const button = document.getElementById('connect');
const local = document.getElementById('local');
const reason = document.getElementById('reason');
const openOwn = document.getElementById('open-own');
const join = document.getElementById('join');
const invite = document.getElementById('invite');
const joinError = document.getElementById('join-error');
const joined = document.getElementById('joined');

const say = (el, text) => {
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
};
const busy = (el, label) => {
  const was = el.textContent;
  el.disabled = true;
  el.textContent = label;
  return () => {
    el.disabled = false;
    el.textContent = was;
  };
};

function showJoined(list) {
  joined.replaceChildren();
  for (const j of list) {
    const row = document.createElement('div');
    row.className = 'joined';
    const text = document.createElement('div');
    text.className = 'grow';
    const name = document.createElement('b');
    name.textContent = j.office;
    const sub = document.createElement('span');
    sub.textContent = `as ${j.guest} · ${j.role}`;
    text.append(name, sub);
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Connect';
    go.disabled = !j.usable;
    go.addEventListener('click', async () => {
      say(joinError, '');
      const done = busy(go, 'Joining…');
      const res = await window.orchConnect.joinSaved(j.id);
      if (res && res.error) {
        say(joinError, res.error);
        done();
      }
    });
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'link';
    forget.textContent = 'forget';
    forget.addEventListener('click', async () => {
      await window.orchConnect.forgetJoined(j.id);
      showJoined((await window.orchConnect.context()).joined);
    });
    // The office to walk into when the app starts, without this screen.
    const auto = document.createElement('label');
    auto.className = 'at-start';
    auto.title = 'Open this office by itself when the app starts';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = j.atStart === true;
    box.addEventListener('change', async () => {
      await window.orchConnect.joinedAtStart(j.id, box.checked);
      showJoined((await window.orchConnect.context()).joined);
    });
    auto.append(box, document.createTextNode(' open at start'));
    row.append(text, auto, go, forget);
    joined.append(row);
  }
}

window.orchConnect.context().then((ctx) => {
  if (ctx.url) {
    document.getElementById('url').value = ctx.url;
    document.getElementById('advanced').open = true;
  }
  say(reason, ctx.reason);
  local.hidden = !ctx.canStartLocal;
  // "My office" is the local one, or the one saved with an owner token; where neither can exist, say so.
  if (!ctx.canStartLocal && !ctx.ownRemote) {
    openOwn.disabled = true;
    document.getElementById('own-what').textContent = 'An office cannot run on this computer itself (employees need tmux). Connect to your office on another machine below, or join someone else\'s.';
  } else if (ctx.ownRemote) document.getElementById('own-what').textContent = `Your office at ${ctx.ownRemote}.`;
  showJoined(ctx.joined || []);
  if (!openOwn.disabled) openOwn.focus();
});

openOwn.addEventListener('click', async () => {
  say(reason, '');
  const done = busy(openOwn, 'Opening…');
  const res = await window.orchConnect.openOwn();
  if (res && res.error) {
    say(reason, res.error);
    done();
  }
});

join.addEventListener('click', async () => {
  say(joinError, '');
  const done = busy(join, 'Joining…');
  const res = await window.orchConnect.join(invite.value);
  if (res && res.error) {
    say(joinError, res.error);
    done();
  }
});
invite.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    join.click();
  }
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  error.style.display = 'none';
  button.disabled = true;
  button.textContent = 'Connecting…';
  const res = await window.orchConnect.connect({ url: document.getElementById('url').value, token: document.getElementById('token').value });
  if (res && res.error) {
    error.textContent = res.error;
    error.style.display = 'block';
    button.disabled = false;
    button.textContent = 'Connect';
  }
});
local.addEventListener('click', () => window.orchConnect.startLocal());
