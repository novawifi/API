**Scope**
- Covers package (pricing) creation, update, and deletion used for hotspot/PPPoE plans.

**Package Fields**
- Name, period, price, speed, devices, usage, category, router host/station, pool (API basis), status.
- For Paybill setups, the system can assign a package account number.

**Exact Error Messages**
- "Missing required fields!"
- "Missing credentials required!"
- "Unauthorised!"
- "Package does not exist!"
- "Package name already exists, choose another name!"
- "Pool is required for API system basis."
- "Invalid update operation tried,mikrotik user profile name cannot be different from database name, try again!"
- "Profile creation failed: ..."
- "Package and MikroTik profile created successfully"
- "Package updated"
- "Package deleted successfully."
- "Failed to delete package from database."
- "Failed to delete MikroTik profile: ..."
- "An internal server error occurred."
- "An error occured"
- "Package creation failed"

**If Package Creation Fails**
- Confirm required fields are present and non-empty.
- Ensure package name is unique per router host.
- For API basis, provide a pool.
- If MikroTik profile creation fails, fix router connectivity and retry.

**If Package Update Fails**
- Ensure profile name matches the existing package name when using MikroTik profiles.
- Re-check pool and router host settings.

**If Package Deletion Fails**
- Confirm the package exists in DB.
- Ensure the MikroTik profile can be removed (router reachable).
- Retry after router connectivity is restored.
