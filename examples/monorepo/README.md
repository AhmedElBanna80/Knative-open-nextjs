# Example Monorepo (Multi-Zone)

This directory demonstrates how to structure a Next.js Monorepo for `zone` distribution mode.

## Structure
- `apps/zone-main`: The root application (handles `/`).
- `apps/zone-dashboard`: The dashboard application (handles `/dashboard`).

## Configuration
In `cn-next.config.ts`, set `distribution_mode: "zone"`.
