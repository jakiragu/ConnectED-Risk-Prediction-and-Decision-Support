# Saved counterfactual choices

Adapted to the four files in counterfactual-current-files.zip, preserving the assessment-comparison and graph update. This replaces the original counterfactual-selection.patch; do not apply both.

Apply the accompanying patch from the repository root:

```
git apply --check counterfactual-selection-compatible.patch
git apply counterfactual-selection-compatible.patch
```

Restart the API and frontend after applying. No reseed, table/index migration or new
package installation is required when the project's dependencies are already installed.
The GraphQL schema and local resolver are included. An AWS deployment must also wire
Mutation.selectStudentTarget to the existing risk-service data source and permit its
DynamoDB UpdateItem operation; this patch does not provision AWS infrastructure.

## Behaviour

- Open the student's risk profile as an administrator or their current class teacher.
- Preview an option, then click **Use this option for this student**.
- A success message and **Saved choice: Option N** confirm saving. Refreshing or opening
  the profile on another signed-in device retrieves the saved choice.
- Previewing alone does not save. Explanation side panels remain previews and show the
  saved/default option on opening; save from the student's risk profile.
- Subject teachers see the permitted subject parts of the saved choice but cannot change
  the student-wide plan. Filtering preserves the original option numbers. If the saved
  plan has no targets for their subjects, no target is borrowed from another plan.
- Saving requires connectivity. Offline option previews are possible; saving is disabled.
- New interventions use the saved option (Option 1 by default), including a snapshot of
  its targets. Existing interventions and their recorded outcomes are not rewritten.
  To replace ongoing support, stop the old intervention and record a new one.
- Saved metadata records the selecting teacher, time and version. A conditional write
  prevents stale simultaneous saves from silently overwriting another teacher's choice.
- Choices belong to a particular prediction. Regenerating/replacing it or producing a new
  checkpoint starts with Option 1. Stale or superseded profile saves are rejected.
- Predicted probabilities, SHAP values, counterfactual outputs and assessment marks are
  unchanged. Only optional selection metadata is added to the prediction record.
- Student prediction reads use the five existing primary keys with consistent reads so
  a newly saved choice is visible immediately, without waiting for GSI propagation.

## Verification

```
node --test --test-concurrency=1 tests/unit/*.test.js tests/store/*.test.js
npm run build:web
```

New tests exercise the real GraphQL documents/resolvers with an isolated dynalite
DynamoDB. They cover save/read persistence, intervention target snapshots, permissions,
invalid indices, stale/concurrent saves, inactive students, subject filtering and reset
on a regenerated prediction. Component tests execute the actual JSX with mocked hooks
and check preview versus save, restored choice, offline disabling and safe status changes.
These are not browser or deployed-AWS end-to-end tests.

Manual check: choose a student with multiple target options, save Option 2, refresh,
open their intervention form and confirm its target values match Option 2. Save a new
intervention and check its target. Change the student's choice again and confirm the old
intervention keeps its original target. Check another browser after signing in.

This focused patch does not include the separate ClassProfile declaration/default-term
fixes discussed earlier.

The uploaded four files are the authoritative base. Other dependencies were taken from
main 63d8fd6 and graphs-compatible-update.zip. The supplied patch changes only the
counterfactual feature and its tests/docs, not the rest of the graph update.
Previewed choices continue to drive the subject chart. Saving updates both the latest
profile targets and the matching assessment-history entry. Earlier panels display the
choice saved for their own prediction, without enabling historical edits.
