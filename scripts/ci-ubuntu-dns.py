"""Resolve only public Ubuntu CI mirrors, without changing system DNS or disabling archive verification."""
import base64
import ipaddress
import json
import struct
import subprocess
import sys
import urllib.request

HOSTS = ('archive.ubuntu.com', 'security.ubuntu.com')


def question(host):
    return b''.join(bytes([len(label)]) + label.encode('ascii') for label in host.split('.')) + b'\0' + struct.pack('!HH', 1, 1)


def decode_reply(data, expected):
    if not 12 <= len(data) <= 65536:
        raise ValueError('Invalid DNS response length')
    identity, flags, questions, answers, _, _ = struct.unpack('!6H', data[:12])
    if identity != 0 or not flags & 0x8000 or flags & 0x021f or questions != 1 or not 1 <= answers <= 256:
        raise ValueError('DNS response rejected, incomplete or validation disabled')
    if data[12:12 + len(expected)] != expected:
        raise ValueError('DNS question does not match the requested mirror')
    offset = 12 + len(expected)
    addresses = set()
    for _ in range(answers):
        while True:
            length = data[offset]
            offset += 1
            if length & 0xc0 == 0xc0:
                if offset >= len(data):
                    raise ValueError('Truncated DNS pointer')
                offset += 1
                break
            if length > 63:
                raise ValueError('Invalid DNS label')
            offset += length
            if length == 0:
                break
        kind, cls, ttl, size = struct.unpack('!HHIH', data[offset:offset + 10])
        offset += 10
        value = data[offset:offset + size]
        if len(value) != size:
            raise ValueError('Truncated DNS record')
        offset += size
        if kind == 1 and cls == 1 and size == 4 and ttl > 0:
            address = ipaddress.IPv4Address(value)
            if address.is_global:
                addresses.add(str(address))
    if not addresses:
        raise ValueError('No public IPv4 mirror address was verified')
    return addresses


def quad9(host):
    # https://docs.quad9.net/services/ and FAQs: DoH requires HTTP/2.
    q = question(host)
    packet = struct.pack('!6H', 0, 0x0100, 1, 0, 0, 0) + q
    url = 'https://dns.quad9.net/dns-query?dns=' + base64.urlsafe_b64encode(packet).decode().rstrip('=')
    reply = subprocess.run(['curl', '--http2', '--fail', '--silent', '--show-error', '--max-time', '20', '--max-filesize', '65536', '--header', 'accept: application/dns-message', url], check=True, stdout=subprocess.PIPE).stdout
    return decode_reply(reply, q)


def google(host):
    # https://developers.google.com/speed/public-dns/docs/doh/json
    with urllib.request.urlopen('https://dns.google/resolve?name=' + host + '&type=A', timeout=20) as response:
        value = json.loads(response.read(65536))
    if value.get('Status') != 0 or value.get('TC') or value.get('CD'):
        raise ValueError('DNS resolver rejected query: ' + json.dumps({k: value.get(k) for k in ('Status', 'TC', 'CD', 'Comment')}))
    if not any(q.get('name', '').rstrip('.') == host and q.get('type') == 1 for q in value.get('Question', [])):
        raise ValueError('DNS question does not match')
    addresses = {str(ipaddress.IPv4Address(row['data'])) for row in value.get('Answer', []) if row.get('type') == 1}
    if not addresses or not all(ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError('No valid public mirror addresses')
    return addresses


def resolve(host):
    if host not in HOSTS:
        raise ValueError('Only the two public Ubuntu archive hosts are allowed')
    for provider in (quad9, google):
        try:
            addresses = provider(host)
            print('Recovered CI DNS for ' + host + ' via ' + provider.__name__ + ' HTTPS; TLS/archive signature verification stays enabled.', file=sys.stderr)
            return addresses
        except Exception as error:
            print('CI DNS ' + provider.__name__ + ': ' + str(error), file=sys.stderr)
    raise RuntimeError('No authenticated HTTPS resolver could verify the CI mirror')


if __name__ == '__main__':
    host = sys.argv[1]
    for address in sorted(resolve(host)):
        print(address, host)
