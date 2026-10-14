# RideSync design notes

## Primary users

- **Operations coordinator:** needs to inspect trips, book a rider, advance trip status, and explain wallet changes.
- **Fleet analyst:** needs a revenue trend, a ranked daily view, materialized-view totals, and a reliable refresh timestamp.
- **Fleet support / customer experience:** needs to locate available vehicles and understand ratings, tags, reviews, and flexible vehicle metadata.

## Visual direction — “Quiet precision”

The interface uses deep ink (`#172B35`), warm paper (`#F6F5F0`), aged brass (`#B88C50`) and muted teal (`#2E746D`). Ink creates structure, brass is reserved for important accents and rankings, and teal denotes healthy/available states. The typography pairs Manrope for headings with DM Sans for interface text and DM Mono for IDs, timestamps, and compact metrics. Cards use thin borders and restrained shadows rather than gradients or heavy effects. Responsive breakpoints collapse the sidebar, grids and tables for smaller screens.

## Wireframes

See `wireframe.svg` for the layout skeleton. It is intentionally low fidelity: navigation, KPI strip, trend panel, recent activity, and the booking form / transaction guarantee panel. The running UI is the source of truth for exact spacing and responsive behavior.

## Reusable patterns

- Status and action pills have consistent semantics across tables and activity lists.
- Tables show a bounded page of records; IDs are shortened for scanning and full IDs remain available in details.
- Forms disable their submit button during writes and show explicit success/failure states.
- Every data view has a loading, empty, and error state.
- Audit history is read-only in the UI and append-only in PostgreSQL.
