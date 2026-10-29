# All action cards, 29 October 2026

The three suggested actions remain the initial shortlist. A prominent **View all actions (count)** button expands every saved open action into the same card grid on Overview and Opportunities. **Show first 3 actions** returns to the shortlist. Counts state how many open actions are displayed. Completed and dismissed work remains in the existing status tabs.

Saved human decisions take precedence. Other cards show the recorded question, relevant review guidance, page if known, evidence controls and an editable next step. Actions without a prepared, page-grounded plan are labelled **Needs investigation**. Expanding the list does not invent a content gap, prepare additional AI suggestions or perform paid answer checks. Existing FAQ drafting remains available on prepared actions.

The recommendations endpoint retains a 100-row page size and adds validated offsets and a next-page marker. Expanding reads every matching page, with project ownership and existing filters enforced. The UI discards partial loads on errors and offers retry. The selected project is checked before applying an asynchronous result.

Expanding and collapsing replace only the card summary section. Open editors and unsaved text stay intact. Additional cards have working editors, including rows beyond the first API page. Saved decision and work-status changes refresh the cards. The grid uses three columns on wide screens, two on medium screens and one on small screens.

Validation: 37 focused action UI, work queue and PostgreSQL-compatible pagination checks passed. Coverage includes all-card expansion and collapse, no paid requests, more than 100 actions without duplicates, editor access, unsaved text preservation, failed-load recovery, project boundaries, existing filters and report handoff. JavaScript syntax checks passed. No dependencies or database migration changes.
