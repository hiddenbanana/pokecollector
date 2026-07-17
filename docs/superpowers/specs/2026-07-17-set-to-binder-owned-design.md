# Add owned set → binder — design

**Date:** 2026-07-17
**Branch:** `feature/set-to-binder-owned` (cut from the deploy branch
`feature/collection-variant-pills-v2`)
**Status:** approved design, ready for implementation plan

## Problem

Building a collection binder one card at a time is tedious when a user already owns
much of a set. The user wants a single action that pulls every owned card of a set into
a chosen binder — **without creating duplicate entries**.

## Confirmed decisions

1. **Entry point:** a control on the Set detail page. The user picks an existing
   collection binder or creates a new one; the action fills that binder.
2. **Dedupe unit:** a *variant* is a unique card. A `CollectionItem` is a distinct
   `(card_id, variant, condition, lang)` row that stacks copies in `quantity`. The
   binder holds **one entry per owned collection item**; copies of the same variant
   stack into that one entry, different variants get separate entries.
3. **Copies allocated elsewhere:** honor the existing cross-binder cap. A physical copy
   lives in only one collection binder. If every copy of an item is already allocated
   across collection binders (`usage_count >= quantity`), skip it.

These map exactly onto the existing collection-binder model, so the feature is the bulk
form of the single-item `add_collection_item_to_binder` endpoint.

## Behavior

For the chosen collection binder and set, iterate the user's owned collection items in
that set. For each item:

- **Already an entry in this binder** → skip, count as `skipped_present`.
- **All copies allocated across collection binders** (`usage_count >= quantity`) → skip,
  count as `skipped_no_capacity`.
- **Otherwise** → add one `BinderCard` with `collection_item_id` set and
  `required_quantity = 1`; count as `added`.

The `(binder_id, collection_item_id)` unique constraint guarantees no duplicate entry
even under concurrent requests.

## Backend

New endpoint in `backend/api/binders.py`:

```
POST /binders/{binder_id}/add-owned-set?set_id=<set_id>
```

- 404 if the binder is missing or not owned by the current user.
- 400 if the binder is not a collection binder (mirrors
  `add_collection_item_to_binder`).
- Query owned `CollectionItem`s joined to `Card` where `Card.set_id == set_id`, filtered
  through `visible_card_filter(db, current_user.id, "all")`.
- Single pass using `_collection_binder_usage_counts(db, current_user)` and the set of
  this binder's existing `collection_item_id`s (one query up front). No per-item
  re-query.
- Insert `BinderCard` rows for the additions, commit once.

Response body:

```json
{
  "added": 12,
  "skipped_present": 3,
  "skipped_no_capacity": 1,
  "owned_total": 16
}
```

`owned_total` is the number of owned collection items considered, so the UI can phrase
"12 added, 4 skipped".

### Reused helpers

- `_collection_binder_usage_counts` — usage per collection item across collection
  binders.
- `visible_card_filter` — hides cards the user has chosen to hide.
- Existing 400/404 guard pattern from `add_collection_item_to_binder`.

## Frontend

- `frontend/src/api/client.js`: `addOwnedSetToBinder(binderId, setId)` →
  `POST /binders/${binderId}/add-owned-set?set_id=${setId}`.
- `frontend/src/pages/SetDetail.jsx`: an **"Add owned to binder"** control that opens a
  small picker modal.
  - Binder list from `getBinders`, filtered to `binder_type === "collection"`.
  - A "New binder" path using the existing `createBinder` call, then add into the new
    binder's id.
  - On success, a toast summarizing the result (added / skipped present / skipped no
    free copy). Refresh binder-dependent views as the page already does.
- i18n: new keys in `frontend/src/i18n/en.js` (button label, modal title, result toast).
  Other locales fall back to `en` for missing keys; no need to translate up front.

## Testing

**Backend** — new `backend/tests/test_binder_add_owned_set.py` (TDD, tests first):

- Owned variants of a set are added as separate entries.
- Multiple copies of one variant produce exactly one entry.
- An item already in the target binder is skipped (`skipped_present`).
- An item whose copies are all allocated to other collection binders is skipped
  (`skipped_no_capacity`).
- A wishlist binder is rejected with 400.
- A set the user owns nothing from (or a foreign set) adds nothing and returns zeros.
- The `(binder_id, collection_item_id)` constraint is respected — re-running the action
  adds nothing the second time.

Run in a container per repo convention (host Node/DB constraints do not apply to pytest,
but follow existing backend test invocation).

**Frontend** — the app currently unit-tests only `cardVariants`. Keep frontend testing
light; no new Vitest suite unless requested. Manual verification of the modal and toast.

## Out of scope

- Bulk add across multiple sets at once.
- Adding to wishlist binders (they use `required_quantity`, not exact copies).
- Choosing *which* variant when the intent is "one entry per card" — superseded: every
  owned variant is its own entry.
- Reworking the cross-binder usage-cap model; the feature honors it as-is.
