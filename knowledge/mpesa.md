**Scope**
- Covers M-PESA/IntaSend/Paystack payment initiation, callbacks, and post-payment activation on the server.

**Required Setup**
- Ensure env values for C2B exist when using STK: `MPESA_C2B_CONSUMER_KEY`, `MPESA_C2B_CONSUMER_SECRET`, `MPESA_C2B_SHORT_CODE`, `MPESA_C2B_PASS_KEY`.
- Ensure service URLs exist: `MPESA_STK_URL`, `MPESA_CALLBACK_URL` (and `MPESA_B2B_URL` if using B2B).
- Ensure platform payment config is saved (Platform payments + Mpesa API settings).

**Payment Flow**
- Validate platform + auth token.
- Initiate STK push.
- Receive callback.
- Activate service (hotspot code or PPPoE enable).
- Send SMS/email if enabled and balance is sufficient.

**Hotspot Activation**
- System attempts to add a hotspot code to MikroTik.
- If add fails, it retries for ~10 seconds before returning a manual-connect message.

**Exact Error Messages**
- "Phone number and amount are required."
- "Missing credentials required!"
- "Missing credentials are required."
- "Missing payment code."
- "Missing required fields in callback data!"
- "Initiator information is invalid"
- "Missing MPESA C2B env consumer credentials."
- "Missing MPESA C2B shortcode or passkey."
- "Missing MPESA C2B initiator credentials."
- "Missing MPESA C2B shortcode."
- "MPESA_STK_URL not set."
- "MPESA C2B STK push failed: missing CheckoutRequestID."
- "Configure Platform payments to continue!"
- "Configure Platform payments to Mpesa API!"
- "Configure Platform payments to Mpesa API Initiator Username!"
- "Configure MPESA C2B destination details in Settings."
- "Failed to initiate STK Push"
- "Payment received, please wait connecting you shortly..."
- "Payment received but failed to automatically connect to WIFI. Please connect manually using M-PESA Message."
- "Payment received but activation failed. Please contact customer care for assistance."
- "Payment successful!"
- "Transaction not successful"
- "MPesa code not found for the given invoice ID."
- "MPesa code not found for the given request reference ID."
- "Invalid paymentLink"
- "Invalid paymentLink!"
- "Bill does not exist!"
- "Platform not found!"
- "SMS not found!"
- "Hotspot SMS sending is disabled!"
- "Insufficient SMS Balance!"
- "Payment not found."
- "Payment is still pending."
- "Payment failed."
- "Payment status unknown."
- "Failed to check payment."
- "Withdrawal amount is too small after fees."
- "Insufficient funds for withdrawal!"
- "You have a pending withdrawal request, wait until it is processed!"
- "Withdrawal initiated successfully!"
- "Withdrawal failed! Intasend error."
- "Withdrawal request failed, try again later!"
- "Unauthorized request!"
- "Unauthorised!"

**User-Friendly Explanations**
- "Initiator information is invalid" -> "The M-PESA initiator PIN is wrong or expired. Re-enter the correct PIN in settings and try again."
- "Missing MPESA C2B env consumer credentials." -> "M-PESA API keys are missing. Add the consumer key/secret in the server env."
- "Missing MPESA C2B shortcode or passkey." -> "Shortcode or passkey is missing. Add them in the server env."
- "Missing MPESA C2B initiator credentials." -> "Initiator username/PIN is missing. Add them in settings and retry."
- "MPESA_STK_URL not set." -> "STK endpoint is not configured. Set `MPESA_STK_URL` in env."
- "Configure Platform payments to continue!" -> "Payments are not enabled for this platform. Enable payments in settings."
- "Configure Platform payments to Mpesa API!" -> "Mpesa API is not configured. Complete Mpesa API setup in settings."
- "Failed to initiate STK Push" -> "STK request failed. Check API credentials, shortcode, passkey, and network reachability."
- "Payment received but failed to automatically connect to WIFI. Please connect manually using M-PESA Message." -> "Payment succeeded but auto-login failed. Use the M-PESA message login code to connect."
- "MPesa code not found for the given invoice ID." -> "The transaction reference did not match any payment. Verify the invoice ID."
- "Payment is still pending." -> "Payment is not completed yet. Wait a minute and retry status check."
- "Payment failed." -> "M-PESA marked the payment as failed. Ask the user to retry payment."

**If STK Push Fails**
- Check platform payment settings and Mpesa API configuration.
- Confirm env values and callback URL are reachable.
- Retry after confirming `MPESA_STK_URL` and credentials are correct.

**If Hotspot Activation Fails**
- Ask user to connect manually using the M-PESA message and login code.
- Check router connectivity and hotspot profile/package mapping.
- Re-run activation or add the code manually to MikroTik.

**If PPPoE Enable Fails**
- Confirm payment link maps to a PPPoE client.
- Check MikroTik connectivity and PPPoE server status.
- Retry enable or enable PPPoE user manually on the router.

**If SMS Fails**
- Confirm SMS wallet exists and balance is sufficient.
- Ensure `sentHotspot` or `sentPPPoE` is enabled for SMS.
- Retry sending after balance top-up.
