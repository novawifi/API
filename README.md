# Nova Server API

This document describes the server API endpoints mounted by the Nova backend.

## Base URL

Default local development URL:

```bash
http://localhost:3013
```

The server mounts routes under the following prefixes:

- `/req` - general controller API
- `/mkt` - MikroTik router / network operations
- `/mpesa` - payment callbacks and transactions
- `/mail` - email sending
- `/twofa` - two-factor authentication
- `/sms` - SMS sending
- `/support` - support tickets and live chat

---

## Common request format

Most endpoints expect JSON request bodies.

```http
POST /req/packages
Content-Type: application/json

{
  "key": "value"
}
```

---

## `/req` endpoints

### Authentication and accounts

- `POST /req/authAdmin`
- `POST /req/authManager`
- `POST /req/loginAdmin`
- `POST /req/loginManager`
- `POST /req/validateToken`
- `POST /req/logoutAdmin`
- `POST /req/createAccount`
- `POST /req/updatePassword`
- `POST /req/resetPassword`
- `POST /req/updateMyPassword`
- `POST /req/updateProfile`
- `POST /req/verifyCode`
- `POST /req/fetchPlatform`
- `POST /req/fetchPlatformSettings`
- `POST /req/fetchPlatformNotifications`
- `POST /req/notifications/dismiss`
- `POST /req/updatePlatformSettings`
- `POST /req/updateAccountPlan`
- `POST /req/updateAdmin`
- `POST /req/deleteAdmin`

### Platform, settings, and management

- `POST /req/addPlatform`
- `POST /req/updatePlatform`
- `POST /req/deletePlatform`
- `POST /req/fetchPlatforms`
- `POST /req/fetchAdmins`
- `POST /req/fetchModerators`
- `POST /req/addModerator`
- `POST /req/updateModerator`
- `POST /req/deleteModerator`
- `POST /req/fetchSettings`
- `POST /req/addSettings`
- `POST /req/updateSettings`
- `POST /req/fetchPlatformSettings`
- `POST /req/saveEmailTemplates`
- `POST /req/fetchEmailTemplates`
- `POST /req/saveSMSConfig`
- `POST /req/saveBrandingSupport`
- `POST /req/uploadBrandingLogo`
- `POST /req/saveTermsOfService`
- `POST /req/fetchTermsOfService`
- `POST /req/publicTerms`
- `POST /req/fetchSidebarArchive`
- `POST /req/updateSidebarArchive`
- `POST /req/fetchConfigs`
- `POST /req/uploadConfig`
- `POST /req/deleteConfig`
- `POST /req/updateConfig`

### Billing and payments

- `POST /req/fetchPayments`
- `POST /req/fetchRecentPayments`
- `POST /req/exportPaymentsCsv`
- `POST /req/exportUsersCsv`
- `POST /req/billPayments`
- `POST /req/cardBilling`
- `POST /req/cardBilling/setup`
- `POST /req/cardBilling/cancel`
- `POST /req/updatePayment`
- `POST /req/deletePayment`
- `POST /req/funds`
- `POST /req/fetchFunds`
- `POST /req/managerBillPayments`
- `POST /req/managerB2BPayments`
- `POST /req/managerDeleteBillPayment`
- `POST /req/managerDeleteB2BPayment`
- `POST /req/managerUpdateBillPayment`
- `POST /req/managerUpdateB2BPayment`
- `POST /req/rechargesms`
- `POST /req/sendBulkSMS`
- `POST /req/scheduleBulkSMS`
- `POST /req/sendInternalSMS`
- `POST /req/sendInternalEmail`
- `POST /req/scheduleInternalSMS`
- `POST /req/scheduleInternalEmail`

### Users, packages, and billing

- `POST /req/packages`
- `POST /req/fetchPackages`
- `POST /req/addPackage`
- `POST /req/updatePackage`
- `POST /req/deletePackage`
- `POST /req/fetchCodes`
- `POST /req/addCode`
- `POST /req/deleteCode`
- `POST /req/updateCode`
- `POST /req/getCodes`
- `POST /req/verifyCode`
- `POST /req/fetchStations`
- `POST /req/fetchStationSummary`
- `POST /req/updateStation`
- `POST /req/deleteStation`
- `POST /req/updateName`
- `POST /req/deleteUser`
- `POST /req/updatePPPoE`
- `POST /req/pppoe`
- `POST /req/pppoeInfo`
- `POST /req/fetchPPPoEPhoneNumbers`
- `POST /req/fetchHotspotPhoneNumbers`
- `POST /req/fetchBackUp`
- `POST /req/filterRevenue`
- `POST /req/stats`
- `POST /req/fetchSessions`
- `POST /req/deleteSession`
- `POST /req/verifyToken`

### Templates and content

- `POST /req/templates`
- `POST /req/addTemplate`
- `POST /req/editTemplate`
- `POST /req/deleteTemplate`
- `POST /req/fetchAllTemplates`
- `POST /req/saveTemplates`
- `POST /req/publicBlogs`
- `POST /req/publicBlog`
- `POST /req/fetchPublicBlogs`
- `POST /req/fetchPublicBlogBySlug`
- `POST /req/homeFibreRequest`
- `POST /req/homeFibreCallbacks`
- `POST /req/homeFibreCallback/resolve`
- `POST /req/homeFibreCallback/delete`
- `GET /req/public/blogs`
- `GET /req/public/blog/:slug`

### Server administration

- `POST /req/serverInfo`
- `POST /req/updateServerInfo`
- `POST /req/restartServerService`
- `POST /req/server/provision`
- `POST /req/server/reboot`
- `POST /req/server/delete`
- `POST /req/server/resize/preview`
- `POST /req/server/resize`
- `POST /req/server/migrations`
- `POST /req/server/migrate`
- `POST /req/resolves`
- `POST /req/fetchPlatformMigrations`
- `POST /req/migratePlatformHosting`
- `POST /req/fetchBackUp`
- `POST /req/radius-credentials`
- `POST /req/migrateSystemBasis`
- `POST /req/managerAuthHealth`
- `POST /req/stations/link`
- `POST /req/stations/unlink`

### File/download endpoints

- `GET /req/dashstats`
- `GET /req/stations`
- `GET /req/backups/remote-hosts/:host/:filename`
- `GET /req/files/:filename`
- `GET /req/backups/login`
- `GET /req/hotspot/login-template`
- `GET /req/hotspot/login-template/:platformID`

---

## `/mkt` endpoints

- `POST /mkt/pools`
- `POST /mkt/stations`
- `POST /mkt/adminStations`
- `POST /mkt/hotspot-profiles`
- `POST /mkt/updatePool`
- `POST /mkt/deletePool`
- `POST /mkt/interfaces`
- `POST /mkt/ppp-profiles`
- `POST /mkt/ppp-servers`
- `POST /mkt/ppp-profile/create`
- `POST /mkt/pppoe-server/create`
- `POST /mkt/pppoe-plan/create`
- `POST /mkt/pppoe-plan/update`
- `POST /mkt/pppoe-plan/delete`
- `POST /mkt/pppoe-plans`
- `POST /mkt/pppoe-user/create`
- `POST /mkt/pppoe-user/update`
- `POST /mkt/pppoe-user/import`
- `POST /mkt/station-summary`
- `POST /mkt/updatePPPoE`
- `POST /mkt/togglePPPoE`
- `POST /mkt/deletePppoE`
- `POST /mkt/connections`
- `POST /mkt/debug-connections`
- `POST /mkt/updateUser`
- `POST /mkt/autoConfigurePPPoE`
- `POST /mkt/isPPPoEAutoConfigured`
- `POST /mkt/autoConfigureHotspot`
- `POST /mkt/isHotspotAutoConfigured`
- `POST /mkt/repair-router`
- `POST /mkt/auto-router/start`
- `GET /mkt/auto-router/script`
- `GET /mkt/auto-router/script/:token`
- `GET /mkt/auto-router/log`
- `GET /mkt/auto-router/complete`
- `GET /mkt/hotspot/expire`
- `POST /mkt/ppp-info`
- `POST /mkt/import`
- `POST /mkt/seed-auto-backup-script`
- `GET /mkt/seed/auto-backup-script.rsc`
- `GET /mkt/seed/auto-backup-script/:platformID/:host/:token.rsc`
- `POST /mkt/station-seed-scripts`
- `POST /mkt/router-backup/notify`
- `GET /mkt/router-backup/notify`
- `PUT /mkt/router-backup/upload`
- `POST /mkt/router-backup/upload`
- `POST /mkt/reboot`
- `GET /mkt/seed/cleanup-expired-hotspot.rsc`
- `GET /mkt/seed/cleanup-3gb-no-expiry-timeout/:platformID/:token.rsc`

---

## `/mpesa` endpoints

- `POST /mpesa/stkpush`
- `POST /mpesa/withdraw`
- `POST /mpesa/confirm`
- `POST /mpesa/payPPPoE`
- `POST /mpesa/paybill`
- `POST /mpesa/paysms`
- `POST /mpesa/verify-transaction`
- `POST /mpesa/reverse-transaction`
- `POST /mpesa/b2b-transfer`
- `POST /mpesa/timeout`
- `POST /mpesa/pull-callback`
- `POST /mpesa/result`
- `POST /mpesa/confirmation`
- `POST /mpesa/validation`
- `POST /mpesa/manager/balance/request`

### Callback endpoints

The server also mounts optional callback paths from environment variables:

- `MPESA_CALLBACK_PATH`
- `INTASEND_WITHDRAWAL_CALLBACK_PATH`
- `INTASEND_DEPOSIT_CALLBACK_PATH`
- `PAYSTACK_DEPOSIT_CALLBACK_PATH`

These are mounted under `/mpesa` when defined.

---

## `/mail` endpoints

- `POST /mail/send`

---

## `/twofa` endpoints

- `POST /twofa/fetchTwoFa`
- `POST /twofa/verify`
- `POST /twofa/generateQRCode`
- `POST /twofa/enable`
- `POST /twofa/disable`
- `GET /twofa/secret`

---

## `/sms` endpoints

- `POST /sms/send`

---

## `/support` endpoints

### Ticket support

- `POST /support/tickets`
- `GET /support/tickets`
- `GET /support/tickets/:id`
- `POST /support/tickets/:id/messages`
- `PATCH /support/tickets/:id/status`

### Live support

- `POST /support/live`
- `GET /support/live`
- `GET /support/live/:id`
- `POST /support/live/:id/messages`
- `PATCH /support/live/:id/status`
- `DELETE /support/live/:id`

### Public live support

- `POST /support/public/live`
- `GET /support/public/live`
- `GET /support/public/live/:id`
- `POST /support/public/live/:id/messages`

---

## Notes

- The server serves static content from `server/public`.
- Non-matching routes return a custom 404 page.
- `README.md` is intended as a high-level reference; consult the source route files for exact request bodies and response shapes.
