/**
 * May a token that came in the page's address (`?token=…`) be taken as this browser's credential?
 *
 * Yes when this browser holds none, and on this computer's own address (the link the office prints for its owner).
 * Anywhere else a link must not swap the credential a person is signed in with for another one: any page could send
 * them here and leave them signed out, or signed in as somebody else without their noticing.
 */
export function adoptUrlToken(stored: string, hostname: string): boolean {
  return !stored || /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/.test(hostname);
}
