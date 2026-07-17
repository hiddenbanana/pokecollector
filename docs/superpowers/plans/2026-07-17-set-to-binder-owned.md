# Add owned set → binder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click action on the Set detail page that pulls every owned card of a set into a chosen collection binder, one entry per owned variant, with no duplicate entries.

**Architecture:** A new backend endpoint `POST /binders/{binder_id}/add-owned-set` loops the single-item `add_collection_item_to_binder` logic over all owned collection items in a set, reusing `_collection_binder_usage_counts` and `visible_card_filter`. The frontend adds an "Add owned to binder" button on `SetDetail.jsx` that opens a binder-picker modal and calls the endpoint.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + @tanstack/react-query + react-hot-toast (frontend), pytest (backend tests via in-memory SQLite).

## Global Constraints

- This working tree is the **live deployment**. Do NOT run `docker compose up --build`. Building tests runs in a throwaway container only.
- Backend tests run in a container: `docker run --rm -v "$PWD/backend":/app -w /app python:3.12 sh -c "pip install -q -r requirements.txt && python -m pytest tests/test_binder_add_owned_set.py -v"`. If a slimmer local venv already runs the suite, that is fine too — the tests use only in-memory SQLite and the imported endpoint function.
- The collection table is `collection`, not `collection_items`. Model is `CollectionItem`.
- A collection binder entry (`BinderCard`) points at exactly one `collection_item_id`; the unique constraint `(binder_id, collection_item_id)` (`uq_binder_collection_item`) forbids the same item twice in one binder.
- Follow the existing 404/400 guard pattern from `add_collection_item_to_binder` verbatim (same status codes and detail phrasing style).
- Frontend: new user-facing strings go in `frontend/src/i18n/en.js` only; other locales fall back to `en`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push; do not open PRs.

---

### Task 1: Backend bulk endpoint + tests

**Files:**
- Modify: `backend/api/binders.py` (add new route after `add_collection_item_to_binder`, ends `backend/api/binders.py:904`)
- Test: `backend/tests/test_binder_add_owned_set.py` (create)

**Interfaces:**
- Consumes (already in `backend/api/binders.py`): `_collection_binder_usage_counts(db, current_user) -> dict[int, int]`, `visible_card_filter(db, user_id, "all")`, models `Binder`, `BinderCard`, `Card`, `CollectionItem`, `datetime`.
- Produces: `add_owned_set_to_binder(binder_id: int, set_id: str, current_user: User, db: Session) -> dict` returning keys `added: int, skipped_present: int, skipped_no_capacity: int, owned_total: int`. Route: `POST /binders/{binder_id}/add-owned-set?set_id=<set_id>`.

- [ ] **Step 1: Write the failing test file**

Create `backend/tests/test_binder_add_owned_set.py`:

```python
import unittest

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.binders import add_owned_set_to_binder, add_collection_item_to_binder
    from database import Base
    from models import Binder, BinderCard, Card, CollectionItem, User
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class AddOwnedSetToBinderTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.card_a = Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1", number="1", lang="en", variants_normal=True)
        self.card_b = Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Floragato", set_id="sv1", number="2", lang="en", variants_normal=True)
        self.foreign_card = Card(id="sv2-1_en", tcg_card_id="sv2-1", name="Charmander", set_id="sv2", number="1", lang="en", variants_normal=True)
        self.db.add_all([self.user, self.card_a, self.card_b, self.foreign_card])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _collection_binder(self, name="My Binder"):
        binder = Binder(name=name, user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        return binder

    def _own(self, card_id, variant="Normal", quantity=1, condition="NM"):
        item = CollectionItem(card_id=card_id, user_id=self.user.id, quantity=quantity, condition=condition, variant=variant, lang="en")
        self.db.add(item)
        self.db.commit()
        self.db.refresh(item)
        return item

    def test_owned_variants_become_separate_entries(self):
        self._own(self.card_a.id, variant="Normal")
        self._own(self.card_a.id, variant="Reverse Holo")
        binder = self._collection_binder()

        result = add_owned_set_to_binder(binder.id, set_id="sv1", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 2)
        self.assertEqual(result["skipped_present"], 0)
        self.assertEqual(result["skipped_no_capacity"], 0)
        self.assertEqual(result["owned_total"], 2)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 2)

    def test_multiple_copies_of_one_variant_make_one_entry(self):
        self._own(self.card_a.id, variant="Normal", quantity=3)
        binder = self._collection_binder()

        result = add_owned_set_to_binder(binder.id, set_id="sv1", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 1)
        self.assertEqual(result["owned_total"], 1)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 1)

    def test_item_already_in_binder_is_skipped(self):
        item = self._own(self.card_a.id, variant="Normal")
        self._own(self.card_b.id, variant="Normal")
        binder = self._collection_binder()
        add_collection_item_to_binder(binder.id, item.id, current_user=self.user, db=self.db)

        result = add_owned_set_to_binder(binder.id, set_id="sv1", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 1)
        self.assertEqual(result["skipped_present"], 1)
        self.assertEqual(result["owned_total"], 2)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 2)

    def test_rerun_adds_nothing(self):
        self._own(self.card_a.id, variant="Normal")
        binder = self._collection_binder()
        add_owned_set_to_binder(binder.id, set_id="sv1", current_user=self.user, db=self.db)

        result = add_owned_set_to_binder(binder.id, set_id="sv1", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["skipped_present"], 1)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 1)

    def test_copy_allocated_to_another_binder_is_skipped(self):
        item = self._own(self.card_a.id, variant="Normal", quantity=1)
        other = self._collection_binder(name="Other")
        add_collection_item_to_binder(other.id, item.id, current_user=self.user, db=self.db)
        target = self._collection_binder(name="Target")

        result = add_owned_set_to_binder(target.id, set_id="sv1", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["skipped_no_capacity"], 1)
        self.assertEqual(result["owned_total"], 1)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == target.id).count(), 0)

    def test_two_copies_one_free_is_added(self):
        item = self._own(self.card_a.id, variant="Normal", quantity=2)
        other = self._collection_binder(name="Other")
        add_collection_item_to_binder(other.id, item.id, current_user=self.user, db=self.db)
        target = self._collection_binder(name="Target")

        result = add_owned_set_to_binder(target.id, set_id="sv1", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 1)
        self.assertEqual(result["skipped_no_capacity"], 0)

    def test_wishlist_binder_is_rejected(self):
        self._own(self.card_a.id, variant="Normal")
        binder = Binder(name="Deck", user_id=self.user.id, binder_type="wishlist")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)

        with self.assertRaises(HTTPException) as ctx:
            add_owned_set_to_binder(binder.id, set_id="sv1", current_user=self.user, db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_foreign_set_adds_nothing(self):
        self._own(self.foreign_card.id, variant="Normal")
        binder = self._collection_binder()

        result = add_owned_set_to_binder(binder.id, set_id="sv1", current_user=self.user, db=self.db)

        self.assertEqual(result, {"added": 0, "skipped_present": 0, "skipped_no_capacity": 0, "owned_total": 0})

    def test_missing_binder_raises_404(self):
        with self.assertRaises(HTTPException) as ctx:
            add_owned_set_to_binder(999, set_id="sv1", current_user=self.user, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker run --rm -v "$PWD/backend":/app -w /app python:3.12 sh -c "pip install -q -r requirements.txt && python -m pytest tests/test_binder_add_owned_set.py -v"`
Expected: FAIL — `ImportError: cannot import name 'add_owned_set_to_binder' from 'api.binders'`.

- [ ] **Step 3: Implement the endpoint**

In `backend/api/binders.py`, add this route immediately after `add_collection_item_to_binder` (after the closing of that function at `backend/api/binders.py:904`):

```python
@router.post("/{binder_id}/add-owned-set")
def add_owned_set_to_binder(
    binder_id: int,
    set_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Bulk-add every owned collection item from a set into a collection binder.

    One entry per owned collection item (variant); copies of a variant stack into
    that single entry. Skips items already in this binder, and items whose copies
    are all allocated across collection binders.
    """
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") != "collection":
        raise HTTPException(status_code=400, detail="Owned cards can only be added to collection binders")

    owned_items = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).filter(
        CollectionItem.user_id == current_user.id,
        Card.set_id == set_id,
        visible_card_filter(db, current_user.id, "all"),
    ).order_by(CollectionItem.id.asc()).all()

    usage_counts = _collection_binder_usage_counts(db, current_user)
    existing_item_ids = {
        item_id for (item_id,) in db.query(BinderCard.collection_item_id).filter(
            BinderCard.binder_id == binder_id,
            BinderCard.collection_item_id.isnot(None),
        ).all()
    }

    added = 0
    skipped_present = 0
    skipped_no_capacity = 0
    for item in owned_items:
        if item.id in existing_item_ids:
            skipped_present += 1
            continue
        if usage_counts.get(item.id, 0) >= (item.quantity or 1):
            skipped_no_capacity += 1
            continue
        db.add(BinderCard(
            binder_id=binder_id,
            card_id=item.card_id,
            collection_item_id=item.id,
            required_quantity=1,
            added_at=datetime.datetime.utcnow(),
        ))
        added += 1

    db.commit()
    return {
        "added": added,
        "skipped_present": skipped_present,
        "skipped_no_capacity": skipped_no_capacity,
        "owned_total": len(owned_items),
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker run --rm -v "$PWD/backend":/app -w /app python:3.12 sh -c "pip install -q -r requirements.txt && python -m pytest tests/test_binder_add_owned_set.py -v"`
Expected: PASS — 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/api/binders.py backend/tests/test_binder_add_owned_set.py
git commit -m "feat: bulk-add owned set into a collection binder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Frontend api client method

**Files:**
- Modify: `frontend/src/api/client.js` (Binders section, after `addCollectionItemToBinder` at `frontend/src/api/client.js:147`)

**Interfaces:**
- Consumes: the `api` axios instance already in the file.
- Produces: `addOwnedSetToBinder(binderId, setId) -> Promise<{added, skipped_present, skipped_no_capacity, owned_total}>`.

- [ ] **Step 1: Add the client method**

In `frontend/src/api/client.js`, immediately after the `addCollectionItemToBinder` line (`frontend/src/api/client.js:147`):

```javascript
export const addOwnedSetToBinder = (binderId, setId) => api.post(`/binders/${binderId}/add-owned-set?set_id=${encodeURIComponent(setId)}`).then(r => r.data)
```

- [ ] **Step 2: Verify it lints/builds (fast check)**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 sh -c "npm ci --no-audit --no-fund && npx vite build"`
Expected: build succeeds (this only confirms the new export does not break the bundle). Skip if Task 3 will be built together — then build once at the end of Task 3.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/client.js
git commit -m "feat: addOwnedSetToBinder api client method

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: SetDetail "Add owned to binder" button + picker modal + i18n

**Files:**
- Modify: `frontend/src/i18n/en.js` (add keys inside the `setDetail:` object, `frontend/src/i18n/en.js:860-882`)
- Modify: `frontend/src/pages/SetDetail.jsx` (imports `frontend/src/pages/SetDetail.jsx:5-6`; component body starts `frontend/src/pages/SetDetail.jsx:281`; set header `frontend/src/pages/SetDetail.jsx:401-450`)

**Interfaces:**
- Consumes: `addOwnedSetToBinder` (Task 2), existing `getBinders`, `createBinder` from `../api/client`; `set.id` from the `getSetChecklist` query `data.set`.
- Produces: user-facing action; no exports consumed by later tasks.

- [ ] **Step 1: Add i18n strings**

In `frontend/src/i18n/en.js`, inside the `setDetail:` object (after `ownedVersions: 'Owned versions',` at `frontend/src/i18n/en.js:870`), add:

```javascript
    addOwnedToBinder: 'Add owned to binder',
    addOwnedToBinderTitle: 'Add owned cards to a binder',
    addOwnedToBinderPick: 'Choose a collection binder',
    addOwnedToBinderNew: 'New binder from this set',
    addOwnedToBinderNoBinders: 'No collection binders yet — create one below.',
    addOwnedToBinderEmpty: 'You do not own any cards in this set yet.',
    addOwnedToBinderResult: 'Added {added}, skipped {skipped}.',
    addOwnedToBinderFailed: 'Failed to add owned cards to binder.',
```

- [ ] **Step 2: Add imports to SetDetail.jsx**

In `frontend/src/pages/SetDetail.jsx`, extend the lucide-react import (`frontend/src/pages/SetDetail.jsx:5`) to include `BookMarked`, and extend the api-client import (`frontend/src/pages/SetDetail.jsx:6`) to add `getBinders`, `createBinder`, `addOwnedSetToBinder`:

```javascript
import { ArrowLeft, Plus, Check, Trash2, X, Heart, BookMarked } from 'lucide-react'
import { getSetChecklist, addToCollection, addToWishlist, updateCollectionItem, removeFromCollection, getBinders, createBinder, addOwnedSetToBinder } from '../api/client'
```

- [ ] **Step 3: Add modal state and mutation in the component body**

In `frontend/src/pages/SetDetail.jsx`, inside `export default function SetDetail()` (after `const { t, pricePrimaryField } = useSettings()` at `frontend/src/pages/SetDetail.jsx:284`), add:

```javascript
  const [binderPickerOpen, setBinderPickerOpen] = useState(false)
  const queryClient = useQueryClient()

  const bindersQuery = useQuery({
    queryKey: ['binders'],
    queryFn: () => getBinders().then(r => r.data),
    enabled: binderPickerOpen,
  })

  const addOwnedMutation = useMutation({
    mutationFn: async ({ binderId, setId }) => {
      let targetId = binderId
      if (!targetId) {
        const created = await createBinder({ name: `${set?.name || setId} (owned)`, binder_type: 'collection' })
        targetId = created.data.id
      }
      return addOwnedSetToBinder(targetId, setId)
    },
    onSuccess: (result) => {
      const skipped = (result.skipped_present || 0) + (result.skipped_no_capacity || 0)
      toast.success(t('setDetail.addOwnedToBinderResult', { added: result.added, skipped }))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      setBinderPickerOpen(false)
    },
    onError: () => toast.error(t('setDetail.addOwnedToBinderFailed')),
  })
```

> Note: `set` is destructured later in the component (`const { set, cards = [], ... } = data || {}` at `frontend/src/pages/SetDetail.jsx:383`). Because the mutation closure reads `set` at call time, this is fine — the modal only opens after data has loaded. If the linter flags use-before-declare, move the `const { set, ... } = data || {}` line up to just after the `useSettings()` line and delete the later duplicate.

- [ ] **Step 4: Add the button in the set header**

In `frontend/src/pages/SetDetail.jsx`, inside the right-hand stats block of the set header. Replace the desktop stats wrapper opening at `frontend/src/pages/SetDetail.jsx:436` (`<div className="text-right hidden md:block flex-shrink-0">`) so the button sits above the stats:

```jsx
          <div className="hidden md:flex flex-col items-end gap-3 flex-shrink-0">
            <button
              onClick={() => setBinderPickerOpen(true)}
              className="btn-secondary flex items-center gap-1.5 text-sm whitespace-nowrap"
            >
              <BookMarked size={14} /> {t('setDetail.addOwnedToBinder')}
            </button>
            <div className="flex gap-4">
              <div>
                <p className="text-2xl font-bold text-green">{owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.owned')}</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-brand-red">{total_count - owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.missing')}</p>
              </div>
            </div>
          </div>
```

(This replaces the existing `<div className="text-right hidden md:block flex-shrink-0">…</div>` block that ends at `frontend/src/pages/SetDetail.jsx:449`. Keep the inner stats markup identical to the original — only the wrapper and the added button change. Verify the `btn-secondary` class exists in `frontend/src/index.css`; if not, use the same classes as another secondary button on the page.)

- [ ] **Step 5: Add the picker modal**

In `frontend/src/pages/SetDetail.jsx`, render the modal near the end of the component's returned JSX (just before the final closing tag of the top-level fragment/div). Use the same `createPortal` + overlay style already imported. Insert:

```jsx
      {binderPickerOpen && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setBinderPickerOpen(false)}>
          <div className="card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-text-primary">{t('setDetail.addOwnedToBinderTitle')}</h2>
              <button onClick={() => setBinderPickerOpen(false)} className="text-text-muted hover:text-text-primary"><X size={18} /></button>
            </div>
            {owned_count === 0 ? (
              <p className="text-sm text-text-secondary">{t('setDetail.addOwnedToBinderEmpty')}</p>
            ) : (
              <>
                <p className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide">{t('setDetail.addOwnedToBinderPick')}</p>
                <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                  {(bindersQuery.data || []).filter(b => (b.binder_type || 'collection') === 'collection').length === 0 && (
                    <p className="text-sm text-text-secondary">{t('setDetail.addOwnedToBinderNoBinders')}</p>
                  )}
                  {(bindersQuery.data || []).filter(b => (b.binder_type || 'collection') === 'collection').map(b => (
                    <button
                      key={b.id}
                      disabled={addOwnedMutation.isPending}
                      onClick={() => addOwnedMutation.mutate({ binderId: b.id, setId: set.id })}
                      className="text-left px-3 py-2 rounded-lg bg-bg-elevated hover:bg-brand-red/10 text-sm text-text-primary disabled:opacity-50"
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
                <button
                  disabled={addOwnedMutation.isPending}
                  onClick={() => addOwnedMutation.mutate({ binderId: null, setId: set.id })}
                  className="btn-primary w-full mt-3 flex items-center justify-center gap-1.5 text-sm disabled:opacity-50"
                >
                  <Plus size={14} /> {t('setDetail.addOwnedToBinderNew')}
                </button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
```

- [ ] **Step 6: Build the frontend to verify it compiles**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 sh -c "npm ci --no-audit --no-fund && npx vite build"`
Expected: build succeeds with no errors. (Use `node:20`, not alpine — host `node_modules` are glibc-built.)

- [ ] **Step 7: Manual verification against the live domain plan**

Do NOT rebuild the running containers as part of this plan. Verification of the deployed change is a separate, explicit deploy step the user controls. For now, confirm the production build compiled in Step 6.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/SetDetail.jsx frontend/src/i18n/en.js
git commit -m "feat: add owned set to a binder from the set page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- The `set_id` sent from the frontend is `set.id` from the checklist response — the same value stored in `Card.set_id`. Do not send the URL slug or set code.
- The endpoint intentionally does not error on an empty result; a set the user owns nothing from returns all-zero counts, which the modal surfaces via `addOwnedToBinderEmpty` before ever calling.
- The unique constraint makes a double-submit safe: a re-run counts everything as `skipped_present` and adds nothing (covered by `test_rerun_adds_nothing`).
- Keep the frontend light — no new Vitest suite (the app currently unit-tests only `cardVariants`). Correctness is covered by the backend tests plus the production build.
