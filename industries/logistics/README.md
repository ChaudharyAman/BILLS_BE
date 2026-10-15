# Logistics Industry Plugin (Backend)

This folder encapsulates all backend configuration, Mongoose schemas, and line-item fields specific to the **Logistics & Freight Forwarding** industry vertical.

## Adding Another Industry (e.g. Healthcare, Retail, Manufacturing)

To create a new industry plugin:
1. Create a new folder under `MBB/industries/` (e.g. `MBB/industries/healthcare/`).
2. Add:
   - `schema.js`: Subdocument schema for the industry's invoice fields (e.g. `batchNo`, `expiryDate`, `drugLicense`).
   - `itemFields.js`: Any line-item specific fields.
   - `constants.js`: Default values and industry-specific options/currencies.
   - `pdfTemplate.js`: Server-side HTML template for PDF generation.
   - `index.js`: Export `id`, `name`, `label`, `schema`, `itemFields`, `pdfTemplate`.
3. Register the industry in `MBB/industries/index.js`.
