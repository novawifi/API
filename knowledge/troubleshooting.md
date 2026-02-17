**Scope**
- Quick triage guide for common failures across payments, hotspot, PPPoE, and router connectivity.

**Auth Failures**
Errors you may see:
- "Missing credentials required!"
- "Missing authentication token"
- "Missing token"
- "Unauthorised!"
- "Unauthorized!"
What to do:
- Confirm the request includes a valid `token`.
- Verify the user has `superuser` or `admin` role where required.

**Router Connectivity**
Errors you may see:
- "No valid MikroTik connection"
- "Failed to connect to MikroTik"
- "Failed to connect to router"
- "Unable to reach router API port."
- "Router reachable but login failed."
- "Failed to diagnose router"
What to do:
- Verify router host/IP, API port, and credentials.
- Check link status and router uptime.
- Retry after network connectivity is restored.

**Hotspot Issues**
Errors you may see:
- "Failed to add user to MikroTik, Package not found!"
- "Failed to add user to MikroTik, Router not found!"
- "Code already exists, try a different one!"
- "No hotspot profiles found in your router!"
- "Profile not found for the hotspot server!"
What to do:
- Confirm package exists and is tied to the correct router.
- Ensure hotspot profiles exist on MikroTik or allow auto-creation.
- Retry voucher creation with a unique code.

**PPPoE Issues**
Errors you may see:
- "PPPoE plan not found"
- "PPPoE user already exists, create a new one!"
- "PPPoE server already exists"
- "Failed to create PPPoE server"
What to do:
- Verify PPPoE plan and router host mapping.
- Ensure PPPoE server/profile names are unique.
- Check MikroTik connection and retry provisioning.

**Payment Issues**
Errors you may see:
- "Failed to initiate STK Push"
- "Payment is still pending."
- "Payment failed."
- "Payment status unknown."
- "Failed to check payment."
What to do:
- Confirm Mpesa API settings and env values.
- Retry payment status check after callback delay.
- Escalate if callback never arrives.

**SMS Issues**
Errors you may see:
- "SMS not found!"
- "Hotspot SMS sending is disabled!"
- "PPPoE SMS sending is disabled!"
- "Insufficient SMS Balance!"
What to do:
- Verify SMS wallet exists and sending is enabled.
- Top up SMS balance and retry sending.
