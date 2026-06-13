# MikroTik SSTP Rescue

The central SSTP service must be active before installing rescue configuration on a router.

Generate one RouterOS script for a router's existing WireGuard address:

```bash
cd /home/kyan/apps/nova-server
node ops/generate-mikrotik-rescue-script.js 10.10.10.13 /tmp/mikrotik-rescue-13.rsc
```

The generated file contains the production rescue password. It is created with mode `0600`.
Upload it to that MikroTik and import it manually:

```routeros
/import file-name=mikrotik-rescue-13.rsc
```

Confirm the tunnel after import:

```routeros
/interface/sstp-client/print detail where name="nova-rescue-sstp"
/ping 10.250.0.1 interface=nova-rescue-sstp count=3
```

Delete the generated `.rsc` from both the server and MikroTik after successful import because it contains credentials.

The bulk utility is dry-run by default:

```bash
node ops/provision-mikrotik-rescue.js
```

It only modifies routers when explicitly run with `--apply`.
