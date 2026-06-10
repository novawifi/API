# Dedicated Server Setup Scripts

Nova provisions Webdock dedicated servers with a Webdock account script. Webdock deploys the account script to `/root/auto-deploy-script` and runs it after server provisioning finishes.

## Files

- `dedicated-server-bootstrap.sh` - runs on the new VPS. Installs and configures system packages, Node.js, PM2, nginx, certbot, PostgreSQL, Redis, UFW, fail2ban, swap, and a health page.
- `sync-dedicated-provision-script.js` - uploads or updates the bootstrap script in Webdock and prints `WEBDOCK_PROVISION_SCRIPT_ID=...`.

## Setup

Run this from the Nova server folder:

```bash
npm run webdock:sync-dedicated-script
```

Add the printed value to production `.env`:

```env
WEBDOCK_PROVISION_SCRIPT_ID=12345
```

New Webdock servers provisioned after this will run the bootstrap script automatically.

## New Server Verification

On a provisioned dedicated server:

```bash
sudo nova-dedicated-check
cat /opt/nova/dedicated-setup-status.json
```

The default health endpoint is:

```text
http://SERVER_IP/health
```

## Notes

- The script prepares the server itself. It does not deploy the Nova API/application code.
- App-specific migration, DNS switching, and portal deployment are still handled by the Nova API/backend flow.
- The script is idempotent enough to rerun after partial failure; check `/var/log/nova/dedicated-bootstrap.log` for details.
