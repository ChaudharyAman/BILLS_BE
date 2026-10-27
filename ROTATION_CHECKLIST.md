# Security Credential Rotation Checklist

> **CRITICAL SECURITY NOTICE**  
> An active `.env` file containing sensitive production/staging credentials was detected inside the distributed repository archive.  
> All exposed credentials must be treated as compromised and rotated immediately following the step-by-step procedures outlined below.

---

## Pre-Rotation Checklist

- [ ] Identify all production and staging environments currently running this code.
- [ ] Confirm that `.env` is un-tracked by git and present in `.gitignore`.
- [ ] Schedule a 15-minute maintenance window (optional, but recommended during DB and encryption key migration).
- [ ] Ensure administrative access to:
  - MongoDB Atlas Cloud Console
  - Cloudinary Management Console
  - NVIDIA NIM Developer Portal
  - Razorpay Dashboard
  - SMTP Relay Provider (Brevo / SendGrid)
  - Google Cloud Console (OAuth Credentials)
  - Production Hosting Platform (VPS / Hostinger / Docker / PM2)

---

## 1. MongoDB Database Credentials (`MONGO_URI`)

### Risk
Direct database access enables data exfiltration, tampering, or deletion across all tenant collections.

### Rotation Procedure
1. Log in to [MongoDB Atlas Console](https://cloud.mongodb.com/).
2. Navigate to **Security** -> **Database Access**.
3. Create a **New Database User**:
   - Authentication Method: Password.
   - Generate a secure 32+ character random password.
   - Database User Privileges: `readWrite` restricted only to the application database (`mybill`).
4. Navigate to **Security** -> **Network Access**:
   - Verify that IP Access List contains only the static IPs of your application servers (avoid `0.0.0.0/0` in production).
5. Update `MONGO_URI` in your production server environment:
   ```env
   MONGO_URI=mongodb+srv://<new_username>:<new_password>@<cluster>.mongodb.net/mybill?retryWrites=true&w=majority
   ```
6. Restart the backend service.
7. Return to MongoDB Atlas -> **Database Access** and **DELETE** the old user account.

---

## 2. JWT Secret (`JWT_SECRET`)

### Risk
Knowledge of `JWT_SECRET` allows an attacker to forge arbitrary JWT authentication tokens with `superadmin` or tenant owner privileges.

### Rotation Procedure
1. Generate a new cryptographically secure 64-character hex secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update `JWT_SECRET` in production `.env`:
   ```env
   JWT_SECRET=<new_64_character_hex_key>
   ```
3. Restart the backend service.
4. **Behavioral Impact**: All previously issued JWT tokens will be rejected immediately with `401 Not authorized, token invalid or expired`. Users and administrators will simply log in again with their standard credentials to receive fresh tokens.

---

## 3. PII Encryption Secret Key (`ENCRYPTION_SECRET_KEY`)

### Risk
Used for AES-256-GCM encryption of employee PII (PAN, Aadhaar, bank account details) at rest.

### Rotation Procedure
> **IMPORTANT**: Rotating this key without re-encrypting existing ciphertext will render existing encrypted fields unreadable. Follow this two-step process:

1. Generate the new key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Run a migration script using both the old key and new key:
   - Read each document with encrypted fields (`Employee.panEncrypted`, `Employee.aadhaarEncrypted`, `Employee.bankAccountEncrypted`).
   - Decrypt using the current/old key.
   - Re-encrypt using the new key.
   - Save the migrated documents.
3. Update `ENCRYPTION_SECRET_KEY` in production `.env` to the new key.
4. Restart the backend service.

---

## 4. Cloudinary Cloud Storage (`CLOUDINARY_*`)

### Risk
Allows unauthorized deletion, upload, or manipulation of uploaded invoices, receipts, and identity documents.

### Rotation Procedure
1. Log in to [Cloudinary Console](https://console.cloudinary.com/).
2. Navigate to **Settings (Gear Icon)** -> **Access Keys**.
3. Click **Generate New Key Pair**.
4. Update production environment variables:
   ```env
   CLOUDINARY_CLOUD_NAME=<your_cloud_name>
   CLOUDINARY_API_KEY=<new_api_key>
   CLOUDINARY_API_SECRET=<new_api_secret>
   ```
5. Deploy and restart backend. Verify that document uploads and downloads function normally.
6. Return to Cloudinary Console and **Revoke/Delete** the old API key pair.

---

## 5. NVIDIA NIM / AI Vision (`NVIDIA_API_KEY`)

### Risk
Exposed keys allow unauthorized consumption of your NVIDIA NIM GPU inference credits.

### Rotation Procedure
1. Log in to [build.nvidia.com](https://build.nvidia.com/).
2. Navigate to your user profile -> **API Keys**.
3. Generate a new API Key with appropriate inference scopes.
4. Update `NVIDIA_API_KEY` in production `.env`:
   ```env
   NVIDIA_API_KEY=nvapi-<new_token>
   ```
5. Restart backend and perform a test invoice OCR scan to confirm connectivity.
6. Delete the old API key from the NVIDIA portal.

---

## 6. Razorpay Payment Gateway (`RAZORPAY_*`)

### Risk
Allows fraudulent manipulation of payment orders, unauthorized refunds, or exposure of transaction records.

### Rotation Procedure
1. Log in to the [Razorpay Dashboard](https://dashboard.razorpay.com/).
2. Go to **Settings** -> **API Keys**.
3. Click **Regenerate Key**:
   - Razorpay offers an option to keep the old key active for 24 hours ("Deactivate old key in 24 hours"). Select this to ensure zero downtime.
4. Copy the new `Key ID` and `Key Secret`.
5. Update production environment variables:
   ```env
   RAZORPAY_KEY_ID=rzp_live_<new_id>
   RAZORPAY_KEY_SECRET=<new_secret>
   ```
6. Restart backend service.
7. Test a subscription payment checkout flow.
8. Deactivate the old key pair once confirmed.

---

## 7. Master User Credentials (`MASTER_USER_PASSWORD`)

### Risk
The master user has diagnostic impersonation access.

### Rotation Procedure
1. Generate a strong passphrase (minimum 16 characters, including uppercase, lowercase, numbers, and special symbols):
   ```bash
   node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"
   ```
2. Update in production `.env`:
   ```env
   MASTER_USER_EMAIL=master@flance.in
   MASTER_USER_PASSWORD=<new_high_entropy_password>
   ```
3. Restart backend. The bootstrap script will automatically update the master user's hashed password and increment `tokenVersion`, invalidating any existing master sessions.

---

## 8. Transactional SMTP Service (`SMTP_*`)

### Risk
Spammers can use compromised SMTP credentials to send phishing emails from your domain, destroying domain reputation.

### Rotation Procedure
1. Log in to your SMTP provider (Brevo / SendGrid / AWS SES).
2. Go to **SMTP & API Keys**.
3. Revoke the exposed SMTP key/password and create a new SMTP credential.
4. Update production `.env`:
   ```env
   SMTP_HOST=<smtp_host>
   SMTP_PORT=587
   SMTP_USER=<smtp_user>
   SMTP_PASS=<new_smtp_password>
   SMTP_SENDER=notifications@yourdomain.com
   ```
5. Restart backend and trigger a test email (e.g., team invite or invoice email).

---

## 9. Google OAuth Credentials (`GOOGLE_CLIENT_SECRET`)

### Risk
Unauthorized applications could impersonate the client credentials for OAuth exchanges.

### Rotation Procedure
1. Log in to the [Google Cloud Console](https://console.cloud.google.com/).
2. Navigate to **APIs & Services** -> **Credentials**.
3. Select the OAuth 2.0 Client ID used by Flance.
4. Click **Reset Secret**.
5. Update `GOOGLE_CLIENT_SECRET` in production `.env`.
6. Restart backend and verify Google Sign-In on the frontend.

---

## Verification & Sign-Off

| Service | Rotated By | Date | Verified Working | Old Key Revoked |
| :--- | :--- | :--- | :--- | :--- |
| MongoDB Atlas | | | [ ] | [ ] |
| JWT Secret | | | [ ] | [ ] |
| Encryption Key | | | [ ] | [ ] |
| Cloudinary | | | [ ] | [ ] |
| NVIDIA NIM | | | [ ] | [ ] |
| Razorpay | | | [ ] | [ ] |
| Master User | | | [ ] | [ ] |
| SMTP Relay | | | [ ] | [ ] |
| Google OAuth | | | [ ] | [ ] |
