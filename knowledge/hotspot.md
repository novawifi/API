**Scope**
- Covers hotspot user creation, hotspot profiles, and MikroTik connectivity for hotspot services.

**Core Flow**
- Validate auth token and platform.
- Verify MikroTik connection.
- Ensure hotspot profile and package exist.
- Add hotspot user (voucher/code) to MikroTik.

**Exact Error Messages**
- "Missing credentials required!"
- "Missing credentials are required parameters"
- "Missing required parameters"
- "Missing required fields"
- "Missing token"
- "Missing token or host"
- "Missing platformID."
- "Missing platformID"
- "Unauthorised!"
- "Unauthorized!"
- "No valid MikroTik connection"
- "Failed to connect to MikroTik"
- "Failed to connect to router"
- "Error fetching hotspot user profiles."
- "Hotspot user profiles fetched successfully"
- "Profile name already exists"
- "Profile not found"
- "Profile '<name>' not found"
- "Invalid shared users value. Use a positive number or 'Unlimited'"
- "Invalid session-timeout format: <value>. Use format like \"1h30m\" or \"1d\""
- "User '<code>' already exists"
- "User added successfully"
- "User '<code>' not found"
- "User removed successfully"
- "Code already exists, try a different one!"
- "Code already exists"
- "Failed to add user to MikroTik, Package not found!"
- "Failed to add user to MikroTik, Router not found!"
- "Failed to add user to MikroTik"
- "Code added successfully"
- "An error occurred while adding the user"
- "No hotspot servers found in your router!"
- "No hotspot profiles found in your router!"
- "No hotspot servers with bridge interface found in your router!"
- "Profile not found for the hotspot server!"
- "DNS name found"

**If Adding a User Fails**
- Verify router connection and credentials.
- Confirm package exists and is linked to the correct router host.
- Ensure hotspot profile exists on MikroTik or let the system create it.

**If Router Connection Fails**
- Check router host/IP and API port reachability.
- Validate MikroTik username/password.
- Retry after confirming connectivity; use router diagnostics if available.

**If Profile Errors Occur**
- Ensure profile name matches the package name.
- Verify session-timeout and shared-user values are valid.
- Recreate or update the hotspot profile.
