# Automated System Test Report

Run ID: `system-test-1780748959934`
Base URL: `http://127.0.0.1:5051`

| Status | Count |
|---|---:|
| PASS | 33 |
| FAIL | 0 |
| SKIP | 3 |

| Result | Test | Detail |
|---|---|---|
| PASS | Health check | Backend responded |
| PASS | Register free user | system-test-1780748959934-free |
| PASS | Register pro user | system-test-1780748959934-pro |
| PASS | Register admin user | system-test-1780748959934-admin |
| PASS | Invalid login is rejected | 401 returned |
| PASS | Promote admin in DB and re-login | Admin role active |
| PASS | Protected route rejects anonymous access | 401 returned |
| PASS | Profile update works | Phone updated |
| PASS | Settings get creates default record | 6a2412a18b8240b8daf3d5f9 |
| PASS | Admin upgrades pro user via admin API | Pro plan assigned |
| PASS | Settings update persists company data | Company profile updated |
| PASS | Client CRUD and search | system-test-1780748959934-client-a |
| PASS | Client bulk create | 2 created |
| PASS | Vendor CRUD and search | system-test-1780748959934-vendor-a |
| PASS | Item CRUD, search, and bulk | system-test-1780748959934-item-a |
| PASS | Free user is blocked from premium report | 403 returned |
| PASS | Invoice create, duplicate reject, get, search, update | system-test-1780748959934-invoice-a |
| PASS | Invoice bulk create | 2 created |
| PASS | Invoice bulk import skips exact duplicates and renumbers conflicts | 1 created, 1 skipped, 1 renumbered |
| PASS | PDF invoice import auto-creates missing client and item | system-test-1780748959934-pdf-client and system-test-1780748959934-pdf-item |
| PASS | PDF extract endpoint rejects missing file | 400 returned |
| PASS | Premium reports and account endpoints load for pro user | Premium invoice endpoints responded |
| PASS | Quote create, update, convert, bulk, delete | 6a2412a28b8240b8daf3d6af |
| PASS | Proforma create, update, convert, bulk, delete | 6a2412a28b8240b8daf3d6e7 |
| PASS | Purchase order create, update, convert, bulk, delete | 6a2412a28b8240b8daf3d71a |
| PASS | Expense create, get, list, update, delete | system-test-1780748959934-expense-a |
| PASS | Subscription status, usage, history, invalid order and invalid verify | Billing endpoints validated |
| PASS | Admin user list and payment history load | 11 users visible |
| SKIP | Browser-rendered frontend, print layouts, and modal UX | Needs Playwright/Cypress browser automation |
| SKIP | Cloudinary logo/signature upload | Needs external upload infrastructure |
| SKIP | Real Razorpay checkout success flow | Needs live payment sandbox and browser callback |
| PASS | Department create, fetch and delete | system-test-1780748959934-Engineering |
| PASS | Employee create, dynamic active list mid-month proration, salary revise | system-test-1780748959934-EMP |
| PASS | Loan create, approve, and payroll EMI amortization | Amortization verified |
| PASS | Reimbursement claim submit, approve, and payroll verification | Reimbursement verified |
| PASS | Logout endpoint responds | Logout responded |

## Notes
- This single-run file automates the core system and backend business flows.
- Browser rendering, print fidelity, Cloudinary uploads, and live Razorpay checkout are marked as skipped because they need a real browser or third-party sandbox.
