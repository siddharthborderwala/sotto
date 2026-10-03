// URL-safe, unambiguous (no 0/o, 1/l/i), 12 chars ≈ 59 bits.
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
export const ID_LENGTH = 12

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("")
}
