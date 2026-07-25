# RoofOps Project Vision

RoofOps is intended to become the permanent operating record for a commercial roof.

The first module, RoofOps Field, serves Watkins Roofing field service work today. It must stay useful on real roofs while the broader platform grows.

## Core Vision

Every building should have a living roof history:

- Work orders
- Leak investigations
- Inspections
- Repairs
- Change orders
- Warranty decisions
- Daily progress reports
- Photos
- PDF reports
- Emails and customer communications
- CompanyCam records
- Roof outlines
- Roof sections
- Roof features
- Pins showing where work happened
- Future drone, thermal, moisture, and AI-assisted findings

The long-term product should answer practical questions quickly:

- What has happened on this roof before?
- Where were the leaks?
- Which roof section was involved?
- What did we repair?
- What photos and reports were sent?
- Is this roof under warranty?
- What condition is the roof in now?
- What should the technician know before walking onto it?

## Current Product

RoofOps Field is a field-first work order app for Watkins Roofing.

It supports:

- Home launcher by work order type
- Leak / Service work orders
- Change Orders
- Inspections
- Repairs
- Warranty work orders
- Return visit amendments
- Photo capture and CompanyCam import
- Roof map pins
- RoofMapper outlines and roof features
- Building History
- Reports
- Daily Progress Reports
- Service Manager workflows
- PDF generation
- Resend email delivery
- CompanyCam PDF save-back
- Feedback backlog
- Firebase Auth roles and permissions
- Netlify serverless integrations

## Product Principles

1. Field work stays fast.
   The app is used by roofers in real job conditions. Basic work should be simple, direct, and phone-friendly.

2. Building history is the durable memory.
   Reports, photos, roof pins, and logged activities should accumulate into a useful history for each building and roof.

3. The past must be enterable.
   RoofOps is not useful if history starts only on the day the app is adopted. Retroactive entries, photos, roof maps, and activity logs matter.

4. CompanyCam remains a system of record.
   CompanyCam holds job photos and saved report PDFs when linked. Do not casually replace this with Firebase Storage.

5. Permissions matter.
   Field users should be able to do field work. Sensitive administrative actions, pricing approval, deletes, purges, and user management require server-side authorization.

6. Build toward SaaS without breaking Watkins.
   Future account-scoped SaaS work should be additive and migration-aware. The current Watkins workflow must not be broken by premature platform abstractions.

## Product Modules

Current:

- RoofOps Field

Emerging:

- RoofMapper
- Building History
- Reports
- Daily Progress Reports
- Service Manager
- Admin / user management

Future:

- RoofOps Dashboard
- RoofOps Admin
- RoofOps Customer Portal
- Multi-company SaaS
- Advanced analytics
- AI-assisted photo issue detection
- AI-assisted summaries and scopes
- Drone/orthomosaic workflows
- Deeper Microsoft 365 / CompanyCam / Foundation integrations

## Non-Goals For Normal Feature Work

- Do not rebuild the app into React, Vite, Next, or another framework as part of ordinary feature work.
- Do not redesign the whole UI while fixing a workflow issue.
- Do not introduce multi-tenant SaaS boundaries until migration is explicitly scoped.
- Do not remove current local/offline safety behavior unless replaced by something safer.
- Do not make production-only assumptions while dev and production share parts of the backend setup.
