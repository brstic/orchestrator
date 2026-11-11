/**
 * What the office's page may make this app do. The page is the office's — served by a machine that is somebody
 * else's — and the app runs on the person's own computer; these are the rules at that line, kept apart from the
 * windows so that they can be tested without one.
 */
const crypto = require('node:crypto');

/** The origin of an address (scheme, host, port), or null when it is not one. */
function originOf(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * May the office's window go to this address? Only within the office itself (or the development page): the same
 * scheme, host and port. Compared as origins — a prefix of the text also fits `https://office.example.com.evil.net/`
 * and `https://office.example.com@evil.net/`.
 */
function staysInOffice(url, allowed) {
  const to = originOf(url);
  return !!to && allowed.map(originOf).some((a) => a && a === to);
}

/**
 * A link the page wants opened outside the app: handed to the system's browser only when it is a web address (or a
 * mail address). Anything else — a file, a network share, another program's own scheme — is what a page should not
 * be able to make the system open.
 */
function externalUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** What the office's page uses: the microphone (talking), the clipboard (terminals), the mouse (walking), full screen, a choice of loudspeaker. */
const PAGE_MAY = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'pointerLock', 'fullscreen', 'speaker-selection']);

/**
 * May a page be given this permission? Only the office's own page, only what the office uses, and of camera and
 * microphone only the microphone. Electron grants everything it is asked for unless told otherwise.
 * `details`: what Electron passes along (`mediaTypes` for a request, `mediaType` for a check).
 */
function pageMay(permission, requestingUrl, details, allowed) {
  if (!staysInOffice(requestingUrl, allowed)) return false;
  if (!PAGE_MAY.has(permission)) return false;
  if (permission === 'media') {
    const kinds = details && Array.isArray(details.mediaTypes) ? details.mediaTypes : details && details.mediaType ? [details.mediaType] : [];
    // (A check that names no kind is the page asking which devices exist: answered for the microphone's sake.)
    return kinds.every((k) => k === 'audio' || k === 'unknown');
  }
  return true;
}

/**
 * The TV's own storage (cookies, logins) for one office. Each office gets its own: the page that embeds the TV
 * controls it, so what a person signed in to on the TV in one office must not be there for the page of another.
 */
function tvPartition(officeUrl, fingerprint) {
  const key = `${originOf(officeUrl) || String(officeUrl || '')}|${String(fingerprint || '')}`;
  return `persist:orch-tv-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

module.exports = { originOf, staysInOffice, externalUrl, pageMay, tvPartition, PAGE_MAY };
