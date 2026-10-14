/**
 * Stellar StrKey validation (G... account and C... contract addresses).
 *
 * Dependency-free so it can run on any runtime. A StrKey is base32 (RFC 4648,
 * no padding) over: one version byte, a 32-byte payload, and a 2-byte CRC16-XModem
 * checksum stored little-endian. 35 bytes encode to exactly 56 characters.
 */

export type StrKeyKind = "G" | "C";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ACCOUNT_VERSION_BYTE = 6 << 3; // 'G'
const CONTRACT_VERSION_BYTE = 2 << 3; // 'C'
const ENCODED_LENGTH = 56;
const DECODED_LENGTH = 35;

function base32Decode(input: string): Uint8Array | undefined {
  let bits = 0;
  let value = 0;
  const out = new Uint8Array(DECODED_LENGTH);
  let index = 0;
  for (const char of input) {
    const digit = BASE32_ALPHABET.indexOf(char);
    if (digit === -1) {
      return undefined;
    }
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      if (index >= DECODED_LENGTH) {
        return undefined;
      }
      out[index] = (value >>> (bits - 8)) & 0xff;
      index += 1;
      bits -= 8;
    }
  }
  return index === DECODED_LENGTH ? out : undefined;
}

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Returns the kind of a valid G or C StrKey, or undefined for anything else. */
export function strKeyKind(value: string): StrKeyKind | undefined {
  if (value.length !== ENCODED_LENGTH) {
    return undefined;
  }
  const bytes = base32Decode(value);
  if (!bytes) {
    return undefined;
  }
  const version = bytes[0];
  const kind: StrKeyKind | undefined =
    version === ACCOUNT_VERSION_BYTE ? "G" : version === CONTRACT_VERSION_BYTE ? "C" : undefined;
  if (!kind) {
    return undefined;
  }
  const body = bytes.subarray(0, DECODED_LENGTH - 2);
  const storedChecksum = bytes[DECODED_LENGTH - 2]! | (bytes[DECODED_LENGTH - 1]! << 8);
  return crc16Xmodem(body) === storedChecksum ? kind : undefined;
}

export function isStellarAddress(value: string): boolean {
  return strKeyKind(value) !== undefined;
}
