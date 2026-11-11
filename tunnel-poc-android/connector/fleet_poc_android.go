// Fleet PoC addition to the pinned upstream cmd/cloudflared package.
// Android has no usable /etc/resolv.conf. The app supplies the CURRENT default
// network's numeric DNS servers. No fixed public resolver is substituted here.
package main

import (
	"context"
	"errors"
	"net"
	"os"
	"strings"
	"sync/atomic"
)

func fleetPocResolver(value string) *net.Resolver {
	var servers []string
	for _, address := range strings.Split(value, ",") {
		if ip := net.ParseIP(address); ip != nil {
			servers = append(servers, net.JoinHostPort(ip.String(), "53"))
		}
	}
	var next atomic.Uint64
	return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		if len(servers) == 0 {
			return nil, errors.New("Android PoC has no network DNS configuration")
		}
		if network != "udp" && network != "tcp" {
			return nil, errors.New("unsupported DNS transport")
		}
		server := servers[(next.Add(1)-1)%uint64(len(servers))]
		return (&net.Dialer{}).DialContext(ctx, network, server)
	}}
}

func init() { net.DefaultResolver = fleetPocResolver(os.Getenv("FLEET_POC_DNS")) }
