**Scope**
- Covers PPPoE plans, PPPoE servers, PPP profiles, and user provisioning on MikroTik.

**Core Flow**
- Validate auth token and platform.
- Ensure MikroTik connection.
- Create PPP profile or PPPoE server if needed.
- Create PPPoE plan in DB.
- Create PPPoE user and optionally enable after payment.

**Exact Error Messages**
- "Missing required fields"
- "Missing required fields!"
- "Missing authentication token"
- "Missing token"
- "Missing platformID."
- "Missing platform ID"
- "Unauthorised!"
- "Unauthorized!"
- "No valid MikroTik connection"
- "Failed to connect to MikroTik"
- "PPPoE plan not found"
- "PPPoE client not found"
- "PPPoE does not exist!"
- "PPPoE plan created successfully"
- "Failed to create plan"
- "Failed to fetch plans"
- "PPP profile already exists"
- "PPP profile created successfully"
- "Failed to create PPP profile"
- "PPPoE server already exists"
- "PPPoE server created successfully"
- "Failed to create PPPoE server"
- "PPPoE user already exists, create a new one!"
- "PPPoE created successfully"
- "PPPoE updated successfully"
- "PPPoE deleted successfully"
- "An error occured, try again!"
- "An error occurred, try again!"
- "PPPoE Server enabled successfully"
- "Failed to enable PPPoE Server!"

**If PPPoE User Creation Fails**
- Verify PPPoE plan exists and is linked to the correct router.
- Ensure MikroTik connection is valid.
- Confirm the username does not already exist on MikroTik.

**If PPPoE Server Creation Fails**
- Confirm router connection and permissions.
- Ensure server name is not a duplicate.
- Retry after checking PPP profile and pool settings.

**If Payment Enable Fails**
- Confirm payment link maps to a PPPoE client.
- Check router API connectivity and PPPoE server status.
- Enable the PPPoE user manually on MikroTik.
