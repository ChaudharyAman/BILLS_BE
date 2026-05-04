# Automated System Test Report

Run ID: `system-test-1777875689773`
Base URL: `http://127.0.0.1:5051`

| Status | Count |
|---|---:|
| PASS | 26 |
| FAIL | 2 |
| SKIP | 3 |

| Result | Test | Detail |
|---|---|---|
| PASS | Health check | Backend responded |
| PASS | Register free user | system-test-1777875689773-free |
| PASS | Register pro user | system-test-1777875689773-pro |
| PASS | Register admin user | system-test-1777875689773-admin |
| PASS | Invalid login is rejected | 401 returned |
| PASS | Promote admin in DB and re-login | Admin role active |
| PASS | Protected route rejects anonymous access | 401 returned |
| PASS | Profile update works | Phone updated |
| PASS | Settings get creates default record | 69f83aeb9cd060dab362048d |
| PASS | Admin upgrades pro user via admin API | Pro plan assigned |
| PASS | Settings update persists company data | Company profile updated |
| PASS | Client CRUD and search | system-test-1777875689773-client-a |
| PASS | Client bulk create | 2 created |
| PASS | Vendor CRUD and search | system-test-1777875689773-vendor-a |
| PASS | Item CRUD, search, and bulk | system-test-1777875689773-item-a |
| PASS | Free user is blocked from premium report | 403 returned |
| PASS | Invoice create, duplicate reject, get, search, update | system-test-1777875689773-invoice-a |
| PASS | Invoice bulk create | 2 created |
| PASS | PDF invoice import auto-creates missing client and item | system-test-1777875689773-pdf-client and system-test-1777875689773-pdf-item |
| PASS | PDF extract endpoint rejects missing file | 400 returned |
| PASS | Premium reports and account endpoints load for pro user | Premium invoice endpoints responded |
| FAIL | Quote create, update, convert, bulk, delete | POST /api/quotes/69f83aec9cd060dab3620518/convert expected 201 but got 400: {"message":"Transaction numbers are only allowed on a replica set member or mongos"} |
| PASS | Proforma create, update, convert, bulk, delete | 69f83aec9cd060dab3620531 |
| PASS | Purchase order create, update, convert, bulk, delete | 69f83aec9cd060dab3620563 |
| FAIL | Expense create, get, list, update, delete | POST /api/expenses expected 201 but got 500: {"message":"next is not a function"} |
| PASS | Subscription status, usage, history, invalid order and invalid verify | Billing endpoints validated |
| PASS | Admin user list and payment history load | 9 users visible |
| SKIP | Browser-rendered frontend, print layouts, and modal UX | Needs Playwright/Cypress browser automation |
| SKIP | Cloudinary logo/signature upload | Needs external upload infrastructure |
| SKIP | Real Razorpay checkout success flow | Needs live payment sandbox and browser callback |
| PASS | Logout endpoint responds | Logout responded |

## Notes
- This single-run file automates the core system and backend business flows.
- Browser rendering, print fidelity, Cloudinary uploads, and live Razorpay checkout are marked as skipped because they need a real browser or third-party sandbox.
