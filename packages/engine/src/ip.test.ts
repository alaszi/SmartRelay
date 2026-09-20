import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './ip';

describe('isBlockedAddress: IPv4 blocklist', () => {
  it.each([
    // this network
    '0.0.0.0',
    '0.1.2.3',
    '0.255.255.255',
    // loopback
    '127.0.0.1',
    '127.255.255.254',
    '127.1.2.3',
    // RFC 1918
    '10.0.0.0',
    '10.255.255.255',
    '172.16.0.0',
    '172.20.5.5',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    // link-local incl. cloud metadata
    '169.254.0.1',
    '169.254.169.254',
    '169.254.255.255',
    // CGNAT
    '100.64.0.0',
    '100.100.100.200',
    '100.127.255.255',
    // protocol assignments, test nets, benchmarking, 6to4 relay
    '192.0.0.1',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
    '198.18.0.1',
    '198.19.255.255',
    '192.88.99.1',
    // multicast, reserved, broadcast
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.0',
    '100.63.255.255', // just below CGNAT
    '100.128.0.0', // just above CGNAT
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255', // just below link-local
    '169.255.0.0', // just above link-local
    '172.15.255.255', // just below 172.16/12
    '172.32.0.0', // just above 172.16/12
    '192.167.255.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '203.0.112.255',
    '203.0.114.0',
    '223.255.255.255',
    '93.184.216.34',
    '185.199.108.153',
  ])('allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('isBlockedAddress: IPv6', () => {
  it.each([
    '::', // unspecified
    '::1', // loopback
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '::2', // IPv4-compatible space
    '::7f00:1', // IPv4-compatible 127.0.0.1
    'fc00::1', // ULA
    'fd00::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe80::1', // link-local
    'fe80::1%eth0', // with zone
    'febf::1',
    'fec0::1', // deprecated site-local
    'ff02::1', // multicast
    'ff00::',
    '100::1', // discard prefix
    '2001:db8::1', // documentation
    '2001:db8:ffff::1',
    '2001::1', // Teredo / IETF assignments
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:1::1',
    '3fff::1', // documentation
    '3fff:fff:ffff::1',
    '4000::1', // outside global unicast
    '8000::1',
    'e000::1',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '2001:4860:4860::8888', // Google DNS
    '2606:4700:4700::1111', // Cloudflare DNS
    '2a00:1450:4001:81b::200e',
    '2001:200::1', // just outside 2001::/23
    '2001:1234::1',
    '2003::1',
    '2400:cb00::1',
    '2fff::1',
    '3ffe::1',
    '3fff:1000::1', // just outside 3fff::/20
  ])('allows the global unicast address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('isBlockedAddress: IPv6 forms that embed an IPv4 address', () => {
  it.each([
    '::ffff:127.0.0.1',
    '::ffff:7f00:1', // same address, hex form
    '0:0:0:0:0:ffff:127.0.0.1',
    '::FFFF:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe', // 169.254.169.254 in hex
    '::ffff:192.168.1.1',
    '::ffff:0.0.0.0',
    '64:ff9b::127.0.0.1', // NAT64
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1', // 10.0.0.1
    '64:ff9b::169.254.169.254',
    '2002:7f00:1::', // 6to4 embedding 127.0.0.1
    '2002:0a00:0001::1', // 6to4 embedding 10.0.0.1
    '2002:a9fe:a9fe::1', // 6to4 embedding 169.254.169.254
    '2002:c0a8:101::1', // 6to4 embedding 192.168.1.1
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::8.8.8.8',
    '2002:808:808::1', // 6to4 embedding 8.8.8.8
  ])('allows %s because the embedded IPv4 address is public', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('isBlockedAddress: fails closed on anything that is not a clean IP literal', () => {
  it.each([
    '',
    ' ',
    'localhost',
    'example.com',
    '127.1', // short form
    '2130706433', // decimal form of 127.0.0.1
    '0x7f000001', // hex form
    '0177.0.0.1', // octal form
    '127.0.0.1 ',
    ' 127.0.0.1',
    '127.0.0.1\n',
    '127.0.0.1.',
    '1.1.1.1.1',
    '256.1.1.1',
    '1.1.1',
    '-1.1.1.1',
    '[::1]',
    '::g',
    ':::',
    '1::2::3',
    '8.8.8.8/32',
    '01.1.1.1',
    '1.1.1.01',
  ])('treats %j as blocked', (value) => {
    expect(isBlockedAddress(value)).toBe(true);
  });
});
