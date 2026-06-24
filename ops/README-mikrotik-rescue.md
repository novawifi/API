# MikroTik SSTP Rescue

The central SSTP service must be active before installing rescue configuration on a router.
The service uses a dedicated RSA certificate at `/etc/nova/sstp-rescue-rsa.crt` because some MikroTik SSTP clients only negotiate the legacy RSA cipher configured here. The generated MikroTik client disables certificate verification for this rescue-only tunnel.

Install rescue on one reachable MikroTik through the existing Nova API connection:

```bash
cd /home/kyan/apps/nova-server
node ops/provision-mikrotik-rescue.js --apply --station 10.10.10.13
```

Configure directly instead of queueing the one-shot router script:

```bash
cd /home/kyan/apps/nova-server
node ops/provision-mikrotik-rescue.js --apply --direct --station 10.10.10.13
```

If direct configuration is slow or times out after the router is reachable, the provisioner falls back to uploading the one-shot installer script and marks that router configured once the installer is queued.

Preview eligible routers without changing anything:

```bash
cd /home/kyan/apps/nova-server
node ops/provision-mikrotik-rescue.js --station 10.10.10.13
```

Install on all eligible routers:

```bash
cd /home/kyan/apps/nova-server
node ops/provision-mikrotik-rescue.js --apply
```

Generate one RouterOS script for a router's existing WireGuard address:

```bash
cd /home/kyan/apps/nova-server
node ops/generate-mikrotik-rescue-script.js 10.10.10.13 /tmp/mikrotik-rescue-13.rsc
```

The generated file contains the production rescue password. It is created with mode `0600`.
Upload it to that MikroTik from the server, then import it:

```bash
scp -P 22 /tmp/mikrotik-rescue-13.rsc admin@10.10.10.13:mikrotik-rescue-13.rsc
ssh -p 22 admin@10.10.10.13 '/import file-name=mikrotik-rescue-13.rsc'
```

Or import it manually from the MikroTik terminal after upload:

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
