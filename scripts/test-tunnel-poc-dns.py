#!/usr/bin/env python3
"""Exercise the exact Android resolver addition on the host using stdlib only."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--go', required=True)
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='fleet-poc-dns-') as temporary:
    target = Path(temporary)
    shutil.copyfile(root / 'tunnel-poc-android/connector/fleet_poc_android.go', target / 'resolver.go')
    (target / 'go.mod').write_text('module fleet-poc-dns-test\n\ngo 1.27.3\n')
    (target / 'resolver_test.go').write_text('''package main
import ("context";"testing";"net")
func TestNoDefaultDNS(t *testing.T) {
 for _,value:=range []string{"", "https://dns.invalid", "not-an-ip", "127.0.0.1:53"} {
  _,err:=fleetPocResolver(value).Dial(context.Background(),"udp","ignored.invalid:53")
  if err==nil {t.Fatal("must fail closed without numeric network DNS")}
 }
}
func TestNetworkDNSAndCancellation(t *testing.T) {
 resolver:=fleetPocResolver("127.0.0.1,::1")
 for _,expected:=range []string{"127.0.0.1:53", "[::1]:53", "127.0.0.1:53"} {
  connection,err:=resolver.Dial(context.Background(),"udp","attacker.invalid:1234")
  if err!=nil {t.Fatal(err)}
  if connection.RemoteAddr().String()!=expected {t.Fatal("untrusted requested DNS target used",connection.RemoteAddr())}
  connection.Close()
 }
 if _,err:=resolver.Dial(context.Background(),"unix","ignored");err==nil {t.Fatal("unsupported transport")}
 cancelled,cancel:=context.WithCancel(context.Background());cancel()
 if _,err:=resolver.Dial(cancelled,"udp","ignored");err==nil {t.Fatal("cancellation ignored")}
 if net.DefaultResolver==nil {t.Fatal("resolver initialization")}
}
''')
    subprocess.run([args.go, 'test', '-count=1', './...'], cwd=target,
                   env=dict(os.environ, GOTOOLCHAIN='local', GOOS='linux', GOARCH='amd64',
                            CGO_ENABLED='0', GOFLAGS='-mod=readonly', GOPROXY='off'), check=True)
print('PASS exact Android DNS addition: numeric network servers, round robin, no implicit resolver, cancellation. Not a physical Android DNS test.')
