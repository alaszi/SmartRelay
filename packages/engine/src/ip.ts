import { isIP } from 'node:net';

/** [network address, prefix length] */
type Cidr4 = readonly [string, number];

// IPv4 ranges that must never be reached from user-supplied URLs (MASTER_PLAN section 8.2).
const BLOCKED_V4: readonly Cidr4[] = [
  ['0.0.0.0', 8], // "this network", includes 0.0.0.0
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
];

/** Strict dotted-decimal parser. Returns an unsigned 32-bit number, or null when not canonical. */
function parseIPv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    // No leading zeros: "010" is ambiguous (octal in some parsers) and never canonical.
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inCidr4(value: number, [network, bits]: Cidr4): boolean {
  const base = parseIPv4(network);
  if (base === null) throw new Error(`invalid CIDR base ${network}`);
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(base / size);
}

function isBlockedV4(value: number): boolean {
  return BLOCKED_V4.some((cidr) => inCidr4(value, cidr));
}

/** Expands an IPv6 literal (any valid textual form, incl. "::" and a dotted tail) to 16 bytes. */
function parseIPv6(input: string): Uint8Array | null {
  let text = input;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (isIP(text) !== 6) return null;

  if (text.includes('.')) {
    const split = text.lastIndexOf(':');
    const v4 = parseIPv4(text.slice(split + 1));
    if (v4 === null) return null;
    const high = Math.floor(v4 / 65536).toString(16);
    const low = (v4 % 65536).toString(16);
    text = `${text.slice(0, split + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

const v4FromBytes = (b: Uint8Array, offset: number): number =>
  (b[offset] ?? 0) * 256 ** 3 +
  ((b[offset + 1] ?? 0) << 16) +
  ((b[offset + 2] ?? 0) << 8) +
  (b[offset + 3] ?? 0);

function prefixMatches(bytes: Uint8Array, prefixHex: string, bits: number): boolean {
  const prefix = Buffer.from(prefixHex, 'hex');
  for (let bit = 0; bit < bits; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function isBlockedV6(bytes: Uint8Array): boolean {
  // IPv4-mapped (::ffff:a.b.c.d): judged by the embedded IPv4 address.
  if (prefixMatches(bytes, '00000000000000000000ffff', 96)) {
    return isBlockedV4(v4FromBytes(bytes, 12));
  }
  // NAT64 well-known prefix (64:ff9b::/96): judged by the embedded IPv4 address.
  if (prefixMatches(bytes, '0064ff9b0000000000000000', 96)) {
    return isBlockedV4(v4FromBytes(bytes, 12));
  }
  // 6to4 (2002::/16) embeds an IPv4 address in bytes 2-5.
  if (prefixMatches(bytes, '2002', 16)) {
    return isBlockedV4(v4FromBytes(bytes, 2));
  }

  // Allow-list: only global unicast (2000::/3) can be public. Everything else is blocked:
  // ::, ::1, IPv4-compatible ::/96, fc00::/7 (ULA), fe80::/10 (link-local), fec0::/10,
  // ff00::/8 (multicast), 100::/64 (discard), unassigned space, ...
  if (!prefixMatches(bytes, '20', 3)) return true;

  // Reserved blocks inside 2000::/3.
  return (
    prefixMatches(bytes, '2001', 23) || // 2001::/23 IETF assignments incl. Teredo (2001::/32)
    prefixMatches(bytes, '20010db8', 32) || // documentation
    prefixMatches(bytes, '3fff', 20) // documentation
  );
}

/**
 * True when `address` must not be contacted: private, loopback, link-local (incl. cloud metadata),
 * CGNAT, multicast, reserved, documentation, or anything that is not a well-formed IP literal.
 * Fails closed: an unparseable value is treated as blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = parseIPv4(address);
    return value === null ? true : isBlockedV4(value);
  }
  if (family === 6) {
    const bytes = parseIPv6(address);
    return bytes === null ? true : isBlockedV6(bytes);
  }
  return true;
}
