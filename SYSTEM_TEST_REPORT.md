# Automated System Test Report

Run ID: `system-test-1779692230494`
Base URL: `http://127.0.0.1:5051`

| Status | Count |
|---|---:|
| PASS | 28 |
| FAIL | 0 |
| SKIP | 3 |

| Result | Test | Detail |
|---|---|---|
| PASS | Health check | Backend responded |
| PASS | Register free user | system-test-1779692230494-free |
| PASS | Register pro user | system-test-1779692230494-pro |
| PASS | Register admin user | system-test-1779692230494-admin |
| PASS | Invalid login is rejected | 401 returned |
| PASS | Promote admin in DB and re-login | Admin role active |
| PASS | Protected route rejects anonymous access | 401 returned |
| PASS | Profile update works | Phone updated |
| PASS | Settings get creates default record | 6a13f2c843feae495fd00b0f |
| PASS | Admin upgrades pro user via admin API | Pro plan assigned |
| PASS | Settings update persists company data | Company profile updated |
| PASS | Client CRUD and search | system-test-1779692230494-client-a |
| PASS | Client bulk create | 2 created |
| PASS | Vendor CRUD and search | system-test-1779692230494-vendor-a |
| PASS | Item CRUD, search, and bulk | system-test-1779692230494-item-a |
| PASS | Free user is blocked from premium report | 403 returned |
| PASS | Invoice create, duplicate reject, get, search, update | system-test-1779692230494-invoice-a |
| PASS | Invoice bulk create | 2 created |
| PASS | PDF invoice import auto-creates missing client and item | system-test-1779692230494-pdf-client and system-test-1779692230494-pdf-item |
| PASS | PDF extract endpoint rejects missing file | 400 returned |
| PASS | Premium reports and account endpoints load for pro user | Premium invoice endpoints responded |
| PASS | Quote create, update, convert, bulk, delete | 6a13f2c843feae495fd00bab |
| PASS | Proforma create, update, convert, bulk, delete | 6a13f2c843feae495fd00be3 |
| PASS | Purchase order create, update, convert, bulk, delete | 6a13f2c843feae495fd00c15 |
| PASS | Expense create, get, list, update, delete | system-test-1779692230494-expense-a |
| PASS | Subscription status, usage, history, invalid order and invalid verify | Billing endpoints validated |
| PASS | Admin user list and payment history load | 10 users visible |
| SKIP | Browser-rendered frontend, print layouts, and modal UX | Needs Playwright/Cypress browser automation |
| SKIP | Cloudinary logo/signature upload | Needs external upload infrastructure |
| SKIP | Real Razorpay checkout success flow | Needs live payment sandbox and browser callback |
| PASS | Logout endpoint responds | Logout responded |

## Notes
- This single-run file automates the core system and backend business flows.
- Browser rendering, print fidelity, Cloudinary uploads, and live Razorpay checkout are marked as skipped because they need a real browser or third-party sandbox.
